/**
 * Per-turn episodic (`<recent_conversation>`, plan §6 K1-4) and knowledge
 * (`<knowledge_available>`, plan §6 K2-6) injection.
 *
 * The properties under test are the ones that decide whether these blocks are
 * safe to leave on by default:
 *
 * - **undefined provider = today's behaviour.** Both options are opt-in, so a
 *   deployment that never wires them must produce byte-identical context.
 * - **budget.** 2 items × ≤200 chars and ≤250 tokens for the episodic block,
 *   ≤2 titles and ≤150 tokens for the knowledge block — the plan's per-turn
 *   automatic-injection increment is ≤400 tokens (G4) and these two blocks are
 *   that increment.
 * - **intent gate.** The episodic block is only for a recall-shaped turn
 *   ("上次…", "we discussed…"); a turn asking for new work must not pay for it.
 * - **failure is a no-op.** A provider that throws leaves the turn exactly as
 *   it would have been, because a retrieval error is not a reason to fail.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  createTransformContext,
  readInjectionReferences,
  recordInjectedGraphHints,
  recordInjectionReference,
} from '../../src/agent/context-transform.js';
import type {
  EpisodicContextItem,
  KnowledgeContextItem,
} from '../../src/agent/context-transform.js';
import { searchEpisodicContext } from '../../src/agent/agent-factory.js';
import type { MemoryRetriever, RetrievedMemory } from '../../src/memory/memory-retriever.js';
import { memoryObservability } from '../../src/memory/observability.js';
import { openDatabase } from '../../src/memory/db.js';
import { MessageRepository } from '../../src/memory/repositories/message-repository.js';
import { estimateTokensForText } from '../../src/shared/token-estimate.js';
import { createKnowledgeService } from '../../src/memory/knowledge/service.js';
import type { KnowledgeService } from '../../src/memory/knowledge/service-contract.js';
import { openSeededDatabase, TWO_MEMORY_SOURCES } from '../knowledge/fixtures.js';

/** The injected text blocks of the (single) user message. */
function textBlocks(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text as string);
}

function joined(content: unknown): string {
  return textBlocks(content).join('\n');
}

/** Number of rendered entries in a `<recent_conversation>` block. */
function episodicEntryCount(block: string): number {
  return block.split('\n').filter((line) => line.startsWith('  ') && line.includes(': ')).length;
}

const RECALL_QUERY = '上次那个 Excel 的批量替换脚本放在哪？';
const NEUTRAL_QUERY = '写一个 TypeScript 的快速排序函数，带注释';

function episodicItems(count: number): EpisodicContextItem[] {
  return Array.from({ length: count }, (_, index) => ({
    createdAt: Date.UTC(2026, 9, 8 + index),
    channel: 'feishu',
    sessionTitle: `目录检查 ${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    // Deliberately far past 200 chars: the transform, not the provider, owns the cap.
    excerpt: `第${index}条片段 `.repeat(80),
  }));
}

describe('per-turn episodic and knowledge injection', () => {
  it('leaves the turn untouched when neither provider is configured', async () => {
    const transform = createTransformContext({ maxMessages: 5, sessionKey: 'inject-off' });

    const messages = [{ role: 'user', content: RECALL_QUERY }];
    const result = await transform(messages);

    expect(result).toEqual([{ role: 'user', content: RECALL_QUERY }]);
    expect(joined(result[0]!.content)).not.toContain('<recent_conversation>');
    expect(joined(result[0]!.content)).not.toContain('<knowledge_available>');
  });

  it('injects at most 2 episodic excerpts, each within the char and token budget', async () => {
    const provider = vi.fn(() => episodicItems(3));
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'inject-episodic-budget',
      episodicContextProvider: provider,
    });

    const result = await transform([{ role: 'user', content: RECALL_QUERY }]);
    const content = result[0]!.content;
    const block = textBlocks(content).find((text) => text.includes('<recent_conversation>'))!;

    expect(provider).toHaveBeenCalledWith(RECALL_QUERY);
    expect(block).toContain('</recent_conversation>');
    expect(episodicEntryCount(block)).toBe(2);
    // Best-first: the third item is the one dropped.
    expect(block).toContain('目录检查 0');
    expect(block).not.toContain('目录检查 2');

    const excerptLines = block
      .split('\n')
      .filter((line) => line.startsWith('  ') && line.includes(': '));
    for (const line of excerptLines) {
      // "  user: " prefix + ≤200 chars of excerpt.
      expect(line.length).toBeLessThanOrEqual('  assistant: '.length + 200);
    }
    expect(estimateTokensForText(block)).toBeLessThanOrEqual(250);
  });

  it('does not inject the episodic block when the query is not about the past', async () => {
    const provider = vi.fn(() => episodicItems(2));
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'inject-episodic-gate',
      episodicContextProvider: provider,
    });

    const result = await transform([{ role: 'user', content: NEUTRAL_QUERY }]);

    expect(provider).not.toHaveBeenCalled();
    expect(joined(result[0]!.content)).not.toContain('<recent_conversation>');
  });

  it('injects at most 2 knowledge titles within the 150-token budget', async () => {
    const provider = vi.fn(
      () =>
        Array.from({ length: 3 }, (_, index) => ({
          slug: `topic/excel-etl-${index}`,
          title: `Excel ETL ${index}：用 Power Query 替代手工 VLOOKUP 的完整说明`.repeat(4),
        })) satisfies KnowledgeContextItem[],
    );
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'inject-knowledge-budget',
      knowledgeContextProvider: provider,
    });

    const result = await transform([{ role: 'user', content: NEUTRAL_QUERY }]);
    const block = textBlocks(result[0]!.content).find((text) =>
      text.includes('<knowledge_available>'),
    )!;

    expect(block).toContain('</knowledge_available>');
    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('<'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('topic/excel-etl-0 — Excel ETL 0');
    expect(lines.join('\n')).not.toContain('excel-etl-2');
    expect(estimateTokensForText(block)).toBeLessThanOrEqual(150);
  });

  it('omits a block whose provider returns nothing', async () => {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'inject-empty-providers',
      episodicContextProvider: () => [],
      knowledgeContextProvider: () => [],
    });

    const result = await transform([{ role: 'user', content: RECALL_QUERY }]);
    const text = joined(result[0]!.content);

    expect(text).not.toContain('<recent_conversation>');
    expect(text).not.toContain('<knowledge_available>');
  });

  it('keeps the turn intact when the episodic provider throws', async () => {
    const logger = { debug: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'inject-episodic-throws',
      logger,
      episodicContextProvider: () => {
        throw new Error('fts index unavailable');
      },
    });

    const result = await transform([{ role: 'user', content: RECALL_QUERY }]);

    expect(result).toEqual([{ role: 'user', content: RECALL_QUERY }]);
    expect(logger.debug).toHaveBeenCalled();
  });

  it('keeps the turn intact when the knowledge provider throws', async () => {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'inject-knowledge-throws',
      knowledgeContextProvider: () => {
        throw new Error('knowledge table missing');
      },
    });

    const result = await transform([{ role: 'user', content: NEUTRAL_QUERY }]);

    expect(result).toEqual([{ role: 'user', content: NEUTRAL_QUERY }]);
  });

  it('appends episodic, then knowledge, then persona after the user text', async () => {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'inject-block-order',
      episodicContextProvider: () => episodicItems(1),
      knowledgeContextProvider: () => [{ slug: 'topic/excel-etl', title: 'Excel ETL' }],
      personaContextProvider: () => '[用户画像]\n偏好简洁回复',
    });

    const result = await transform([{ role: 'user', content: RECALL_QUERY }]);
    const text = joined(result[0]!.content);

    expect(text.startsWith(RECALL_QUERY)).toBe(true);
    expect(text.indexOf('<recent_conversation>')).toBeGreaterThan(0);
    expect(text.indexOf('<knowledge_available>')).toBeGreaterThan(
      text.indexOf('</recent_conversation>'),
    );
    // Persona is last by design: the current preference must override any stale
    // name or fact carried by the retrieved blocks above it.
    expect(text.indexOf('<persona>')).toBeGreaterThan(text.indexOf('</knowledge_available>'));
  });

  it('keeps the combined increment of the two blocks within the 400-token plan limit', async () => {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'inject-combined-budget',
      episodicContextProvider: () => episodicItems(2),
      knowledgeContextProvider: () => [
        { slug: 'topic/excel-etl', title: 'Excel ETL：用 Power Query 替代手工 VLOOKUP' },
        { slug: 'project/ohmyagent', title: 'OhMyAgent' },
      ],
    });

    const result = await transform([{ role: 'user', content: RECALL_QUERY }]);
    const injected = textBlocks(result[0]!.content)
      .filter(
        (text) => text.includes('<recent_conversation>') || text.includes('<knowledge_available>'),
      )
      .join('\n');

    expect(estimateTokensForText(injected)).toBeLessThanOrEqual(400);
  });
});

/**
 * The self-echo guard.
 *
 * On the WebUI path the user message is persisted *before* the transform runs,
 * so a malformed window lets the turn match its own query and inject the
 * sentence the model is already looking at back as "recent conversation",
 * spending one of the two slots. The provider therefore bounds the search at
 * the turn start rather than at "now".
 *
 * These tests drive the real `searchEpisodicContext` (not a stub) against a
 * real FTS index: the guard lives in the retrieval, so a stub cannot exercise
 * it. The timestamps are relative to the wall clock on purpose — the unguarded
 * fallback searches up to `Date.now()`, and a fixed future date would make the
 * unguarded run return nothing, hiding the defect instead of exposing it.
 */
describe('episodic self-echo guard', () => {
  const TURN_START = Date.now() - 60_000;
  const PREVIOUS_EXCHANGE_AT = TURN_START - 3_600_000;
  /** Lives in the current turn's own (already persisted) user message. */
  const ECHO_TOKEN = 'ECHOTOKEN';
  const PREV_TOKEN = 'PREVTOKEN';
  const CURRENT_TURN_TEXT = `${RECALL_QUERY} ${ECHO_TOKEN}`;

  let db: Database.Database;
  let messages: MessageRepository;

  function seedMessage(id: string, content: string, createdAt: number, role = 'user'): void {
    messages.create({ id, session_id: 's-echo', role, content, created_at: createdAt });
  }

  beforeEach(() => {
    db = openDatabase(':memory:');
    messages = new MessageRepository(db);
    db.prepare(
      `INSERT INTO sessions (id, chat_id, user_id, project_id, channel, external_chat_id, title, metadata, created_at, updated_at)
       VALUES ('s-echo', 's-echo', 'user-1', NULL, 'webui', NULL, 'Echo', NULL, '1700000000000', '1700000000000')`,
    ).run();
    // The previous turn's exchange, an hour ago …
    seedMessage(
      'echo-prev',
      `上次那个 Excel 的批量替换脚本在 ${PREV_TOKEN} 里`,
      PREVIOUS_EXCHANGE_AT,
    );
    // … and this turn's user message, already persisted when the transform runs.
    seedMessage('echo-current', CURRENT_TURN_TEXT, TURN_START);
  });

  afterEach(() => {
    db.close();
  });

  it('injects the earlier excerpt but not the message created at turn start', async () => {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'inject-episodic-self-echo',
      episodicContextProvider: (query) =>
        searchEpisodicContext({ db, query, limit: 2, turnStart: TURN_START }),
    });

    const result = await transform([{ role: 'user', content: CURRENT_TURN_TEXT }]);
    const block = textBlocks(result[0]!.content).find((text) =>
      text.includes('<recent_conversation>'),
    )!;

    // The older hit still makes it in — the guard narrows the window, it does
    // not disable the block.
    expect(block).toContain(PREV_TOKEN);
    expect(block).not.toContain(ECHO_TOKEN);
    expect(episodicEntryCount(block)).toBe(1);
  });

  it('drops a post-turn-start message that arrives only as a neighbour', () => {
    // The ±1 expansion rebuilds an exchange from the session timeline and
    // ignores the FTS time window, so a message that is not a hit of its own
    // still comes back next to the last pre-turn hit. `until` alone cannot stop
    // that; the provider's post-filter is what does.
    const items = searchEpisodicContext({
      db,
      query: PREV_TOKEN,
      limit: 4,
      turnStart: TURN_START,
    });

    expect(items.map((item) => item.excerpt).join('\n')).toContain(PREV_TOKEN);
    expect(items.map((item) => item.excerpt).join('\n')).not.toContain(ECHO_TOKEN);
    expect(items.every((item) => item.createdAt < TURN_START)).toBe(true);
  });

  it('does not let the current message take the injection slot the older hit needs', async () => {
    // The other half of the guard. `until` is what keeps the turn's own message
    // out of the *hit* list; without it the current sentence — which matches the
    // query by construction, being the query — ranks above the older exchange
    // and consumes the budget, so a one-slot block comes back empty.
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'inject-episodic-slot-displacement',
      episodicContextProvider: (query) =>
        searchEpisodicContext({ db, query, limit: 1, turnStart: TURN_START }),
    });

    const result = await transform([{ role: 'user', content: CURRENT_TURN_TEXT }]);
    const block = textBlocks(result[0]!.content).find((text) =>
      text.includes('<recent_conversation>'),
    )!;

    expect(block).toContain(PREV_TOKEN);
    expect(block).not.toContain(ECHO_TOKEN);
  });

  it('keeps the pre-guard window when no turn boundary is supplied', () => {
    // A child agent built outside AgentService has no turn context and never
    // eagerly persists its prompt, so there is nothing to exclude.
    const items = searchEpisodicContext({ db, query: ECHO_TOKEN, limit: 2 });

    expect(items.map((item) => item.excerpt).join('\n')).toContain(ECHO_TOKEN);
  });
});

/**
 * Per-turn injection telemetry (plan §6 K0 item 3).
 *
 * The transform is the only place that knows what automatic injection cost a
 * turn and which ids it spent budget on, and it is the only place that can
 * record it: the ids are chosen here and, without this, discarded here.
 *
 * Properties under test: silence when nothing was injected (a row per empty
 * turn is noise), ids rather than text, one row per prompt build however many
 * lanes injected, and `degraded` when a lane threw but the turn still
 * completed.
 */
describe('per-turn injection instrumentation', () => {
  let record: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    record = vi.spyOn(memoryObservability, 'record');
  });

  afterEach(() => {
    record.mockRestore();
  });

  /** The single emitted `memory.injection` payload. */
  function injectedDetails(): Record<string, any> {
    expect(record).toHaveBeenCalledTimes(1);
    const call = record.mock.calls[0]!;
    expect(call[0]).toBe('memory.injection');
    return (call[1] ?? {}) as Record<string, any>;
  }

  function memoryRetrieverReturning(memories: RetrievedMemory[]): MemoryRetriever {
    return {
      retrieveGrouped: async () => memories,
      retrieve: async () => memories,
    } as unknown as MemoryRetriever;
  }

  const MEMORY_WITH_EMPTY_CONTENT: RetrievedMemory[] = [
    {
      id: 'mem-1',
      content: '偏好简洁回复，不要长篇大论',
      scope: 'user',
      kind: 'preference',
      score: 0.9,
      createdAt: 1,
    },
    // Dropped by the read-path filter — it must not appear in `memoryIds`.
    { id: 'mem-empty', content: '   ', scope: 'user', kind: 'fact', score: 0.2, createdAt: 2 },
  ];

  it('writes no event when no block was injected', async () => {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'telemetry-silent',
      episodicContextProvider: () => [],
      knowledgeContextProvider: () => [],
    });

    await transform([{ role: 'user', content: RECALL_QUERY }]);

    expect(record).not.toHaveBeenCalled();
  });

  it('records the injected excerpts with their message ids and token cost', async () => {
    const items: EpisodicContextItem[] = episodicItems(2).map((item, index) => ({
      ...item,
      messageId: `msg-${index}`,
    }));
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'telemetry-episodic',
      episodicContextProvider: () => items,
    });

    const result = await transform([{ role: 'user', content: RECALL_QUERY }]);
    const details = injectedDetails();

    expect(joined(result[0]!.content)).toContain('<recent_conversation>');
    expect(details.messageIds).toEqual(['msg-0', 'msg-1']);
    expect(details.memoryIds).toEqual([]);
    expect(details.knowledgeSlugs).toEqual([]);
    expect(details.itemCounts).toEqual({ memories: 0, messages: 2, knowledge: 0 });
    expect(details.estimatedTokens.messages).toBeGreaterThan(0);
    expect(details.estimatedTokens.total).toBe(details.estimatedTokens.messages);
    expect(details.latencyMs.messages).toBeGreaterThanOrEqual(0);
    expect(details.status).toBe('ok');
  });

  it('records trimmed knowledge slugs, not the titles', async () => {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'telemetry-knowledge',
      knowledgeContextProvider: () => [
        { slug: 'topic/excel-etl', title: 'Excel ETL：用 Power Query 替代手工 VLOOKUP' },
      ],
    });

    await transform([{ role: 'user', content: NEUTRAL_QUERY }]);
    const details = injectedDetails();

    expect(details.knowledgeSlugs).toEqual(['topic/excel-etl']);
    expect(details.itemCounts).toEqual({ memories: 0, messages: 0, knowledge: 1 });
    expect(details.estimatedTokens.knowledge).toBeGreaterThan(0);
    expect(details.status).toBe('ok');
  });

  it('records the memories that survived the read-path filters', async () => {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'telemetry-memory',
      agentId: 'agent-1',
      memoryRetriever: memoryRetrieverReturning(MEMORY_WITH_EMPTY_CONTENT),
    });

    const result = await transform([{ role: 'user', content: NEUTRAL_QUERY }]);
    const details = injectedDetails();

    expect(joined(result[0]!.content)).toContain('<memory_context>');
    expect(details.memoryIds).toEqual(['mem-1']);
    expect(details.itemCounts).toEqual({ memories: 1, messages: 0, knowledge: 0 });
    expect(details.estimatedTokens.memories).toBeGreaterThan(0);
    expect(details.status).toBe('ok');
  });

  it('marks the turn degraded when a lane throws, and still completes it', async () => {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'telemetry-degraded',
      episodicContextProvider: () => {
        throw new Error('fts index unavailable');
      },
      knowledgeContextProvider: () => [{ slug: 'topic/excel-etl', title: 'Excel ETL' }],
    });

    const result = await transform([{ role: 'user', content: RECALL_QUERY }]);
    const details = injectedDetails();

    expect(joined(result[0]!.content)).toContain('<knowledge_available>');
    expect(joined(result[0]!.content)).not.toContain('<recent_conversation>');
    expect(details.messageIds).toEqual([]);
    expect(details.knowledgeSlugs).toEqual(['topic/excel-etl']);
    expect(details.status).toBe('degraded');
  });

  it('stays silent when a lane throws and nothing else was injected', async () => {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'telemetry-degraded-silent',
      episodicContextProvider: () => {
        throw new Error('fts index unavailable');
      },
    });

    await transform([{ role: 'user', content: RECALL_QUERY }]);

    expect(record).not.toHaveBeenCalled();
  });

  it('emits exactly one event per prompt build, however many lanes injected', async () => {
    // maxMessages forces the trimming exit, so this also proves the event is
    // not tied to a single return path.
    const transform = createTransformContext({
      maxMessages: 2,
      sessionKey: 'telemetry-single-event',
      agentId: 'agent-1',
      memoryRetriever: memoryRetrieverReturning(MEMORY_WITH_EMPTY_CONTENT),
      episodicContextProvider: () => [{ ...episodicItems(1)[0]!, messageId: 'msg-prev' }],
      knowledgeContextProvider: () => [{ slug: 'topic/excel-etl', title: 'Excel ETL' }],
    });

    const result = await transform([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
      { role: 'user', content: RECALL_QUERY },
    ]);
    const details = injectedDetails();

    expect(result).toHaveLength(3);
    expect(details.itemCounts).toEqual({ memories: 1, messages: 1, knowledge: 1 });
    expect(details.memoryIds).toEqual(['mem-1']);
    expect(details.messageIds).toEqual(['msg-prev']);
    expect(details.knowledgeSlugs).toEqual(['topic/excel-etl']);
    expect(details.estimatedTokens.total).toBe(
      details.estimatedTokens.memories +
        details.estimatedTokens.messages +
        details.estimatedTokens.knowledge,
    );
    expect(details.estimatedTokens.total).toBeGreaterThan(details.estimatedTokens.memories);
    expect(details.status).toBe('ok');
  });
});

/**
 * Cross-block budget allocation (plan §6 K5 item 4).
 *
 * Before K5-4 the two blocks were built independently and appended in a fixed
 * order, each with its own 250/150-token budget — so a weak knowledge title
 * spent tokens a much better excerpt needed. Now one ranking pass allocates the
 * shared ≤400-token pool, while the blocks keep their labels and counts.
 *
 * The budgets in these tests are derived from the same estimator the transform
 * uses (`blockTokens` measures what a lone provider injects), so the assertion is
 * about *who wins the pool*, never about a hand-computed token count that would
 * rot the moment an entry grows a character.
 */
describe('cross-block budget allocation (K5-4)', () => {
  const SHORT_EPISODIC: EpisodicContextItem[] = [
    {
      createdAt: Date.UTC(2026, 9, 8),
      channel: 'feishu',
      sessionTitle: '目录检查',
      role: 'user',
      excerpt: '上次那个 ETL 脚本放在 /srv/etl 下，批量替换用的是 Python',
      messageId: 'msg-alloc',
    },
  ];
  const TITLE: KnowledgeContextItem[] = [
    { slug: 'topic/excel-etl', title: 'Excel ETL：用 Power Query 替代手工 VLOOKUP' },
  ];

  let record: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    record = vi.spyOn(memoryObservability, 'record');
  });
  afterEach(() => {
    record.mockRestore();
  });

  /**
   * The `memory.injection` payload of the LAST build in the test. The budget
   * measurements above are builds too, so "the only call" is not an assertion
   * these tests can make.
   */
  function lastInjectionDetails(): Record<string, any> {
    const calls = record.mock.calls.filter((call) => call[0] === 'memory.injection');
    expect(calls.length).toBeGreaterThan(0);
    return (calls[calls.length - 1]![1] ?? {}) as Record<string, any>;
  }

  async function injectedText(options: {
    sessionKey: string;
    episodic?: EpisodicContextItem[];
    knowledge?: KnowledgeContextItem[];
    totalTokens?: number;
    episodicTokens?: number;
    knowledgeTokens?: number;
    query?: string;
  }): Promise<string> {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: options.sessionKey,
      injectionBudget: {
        totalTokens: options.totalTokens ?? 10_000,
        episodicTokens: options.episodicTokens,
        knowledgeTokens: options.knowledgeTokens,
      },
      episodicContextProvider: options.episodic ? () => options.episodic! : undefined,
      knowledgeContextProvider: options.knowledge ? () => options.knowledge! : undefined,
    });
    const result = await transform([{ role: 'user', content: options.query ?? RECALL_QUERY }]);
    return textBlocks(result[0]!.content)
      .filter(
        (text) => text.includes('<recent_conversation>') || text.includes('<knowledge_available>'),
      )
      .join('\n');
  }

  /** Tokens the two blocks cost when each is injected alone, at a huge budget. */
  async function blockTokens(): Promise<{ episodic: number; knowledge: number }> {
    const sessionKey = `alloc-measure-${Math.random().toString(36).slice(2)}`;
    const episodicOnly = await injectedText({ sessionKey, episodic: SHORT_EPISODIC });
    const knowledgeOnly = await injectedText({ sessionKey, knowledge: TITLE });
    return {
      episodic: Math.ceil(estimateTokensForText(episodicOnly)),
      knowledge: Math.ceil(estimateTokensForText(knowledgeOnly)),
    };
  }

  it('gives the pool to the better-scored episode over the weaker knowledge title', async () => {
    const { episodic, knowledge } = await blockTokens();
    // Fits either block alone; fits neither pair together.
    const totalTokens = Math.max(episodic, knowledge);
    expect(episodic + knowledge).toBeGreaterThan(totalTokens);

    const text = await injectedText({
      sessionKey: 'alloc-episodic-wins',
      totalTokens,
      episodic: [{ ...SHORT_EPISODIC[0]!, score: 0.9 }],
      knowledge: [{ ...TITLE[0]!, score: 0.05 }],
    });

    expect(text).toContain('<recent_conversation>');
    expect(text).toContain('ETL 脚本');
    expect(text).not.toContain('<knowledge_available>');

    const details = lastInjectionDetails();
    expect(details.itemCounts).toEqual({ memories: 0, messages: 1, knowledge: 0 });
    expect(details.messageIds).toEqual(['msg-alloc']);
    expect(details.knowledgeSlugs).toEqual([]);
  });

  it('gives the pool to the better-scored knowledge title over a weak episode', async () => {
    const { episodic, knowledge } = await blockTokens();
    const totalTokens = Math.max(episodic, knowledge);

    const text = await injectedText({
      sessionKey: 'alloc-knowledge-wins',
      totalTokens,
      episodic: [{ ...SHORT_EPISODIC[0]!, score: 0.02 }],
      knowledge: [{ ...TITLE[0]!, score: 0.9 }],
    });

    expect(text).toContain('<knowledge_available>');
    expect(text).toContain('topic/excel-etl');
    expect(text).not.toContain('<recent_conversation>');

    const details = lastInjectionDetails();
    expect(details.itemCounts).toEqual({ memories: 0, messages: 0, knowledge: 1 });
    expect(details.knowledgeSlugs).toEqual(['topic/excel-etl']);
    expect(details.messageIds).toEqual([]);
  });

  it('keeps both labelled blocks and their per-lane counts when both fit', async () => {
    const text = await injectedText({
      sessionKey: 'alloc-both-fit',
      episodic: SHORT_EPISODIC,
      knowledge: TITLE,
    });

    expect(text.indexOf('<recent_conversation>')).toBeGreaterThan(-1);
    expect(text.indexOf('<knowledge_available>')).toBeGreaterThan(
      text.indexOf('</recent_conversation>'),
    );

    const details = lastInjectionDetails();
    expect(details.itemCounts).toEqual({ memories: 0, messages: 1, knowledge: 1 });
    expect(details.messageIds).toEqual(['msg-alloc']);
    expect(details.knowledgeSlugs).toEqual(['topic/excel-etl']);
    expect(details.estimatedTokens.total).toBeLessThanOrEqual(400);
  });

  it('drops the entry that does not fit instead of starving the other lane', async () => {
    const { knowledge } = await blockTokens();
    // Enough for the title line, not for the (larger) excerpt block.
    const text = await injectedText({
      sessionKey: 'alloc-drop-oversized',
      totalTokens: knowledge,
      episodic: episodicItems(2).map((item, index) => ({ ...item, messageId: `msg-${index}` })),
      knowledge: TITLE,
    });

    expect(text).toContain('<knowledge_available>');
    expect(text).not.toContain('<recent_conversation>');
  });

  it('honours a per-lane ceiling from configuration', async () => {
    const text = await injectedText({
      sessionKey: 'alloc-lane-ceiling',
      episodicTokens: 1,
      episodic: SHORT_EPISODIC,
      knowledge: TITLE,
    });

    expect(text).not.toContain('<recent_conversation>');
    expect(text).toContain('<knowledge_available>');
  });

  it('still gates the episodic lane on a recall-shaped query', async () => {
    const episodicProvider = vi.fn(() => SHORT_EPISODIC);
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'alloc-intent-gate',
      episodicContextProvider: episodicProvider,
      knowledgeContextProvider: () => TITLE,
    });

    const result = await transform([{ role: 'user', content: NEUTRAL_QUERY }]);
    const text = joined(result[0]!.content);

    expect(episodicProvider).not.toHaveBeenCalled();
    expect(text).not.toContain('<recent_conversation>');
    // The knowledge lane is not gate-kept by intent and still injects.
    expect(text).toContain('<knowledge_available>');
  });
});

/**
 * Reference tracking (plan §6 K0 item 3, ②「是否被引用」).
 *
 * Only the knowledge lane can be checked: a page is read with `knowledge_get`,
 * while memories and excerpts have no tool that reads them back. The offer is
 * published by the transform build and consumed by the tool hook, so these
 * tests drive the two seams in order: run the transform, then report the call.
 */
describe('injection reference tracking', () => {
  let record: ReturnType<typeof vi.spyOn>;

  const SLUG = 'topic/excel-etl';

  beforeEach(() => {
    record = vi.spyOn(memoryObservability, 'record');
  });

  afterEach(() => {
    record.mockRestore();
  });

  async function offerSlugs(sessionKey: string, slugs: string[]): Promise<void> {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey,
      agentId: 'agent-ref',
      knowledgeContextProvider: () => slugs.map((slug) => ({ slug, title: 'Excel ETL' })),
    });
    await transform([{ role: 'user', content: NEUTRAL_QUERY }]);
  }

  it('records a read of an offered page once, and consumes the offer', async () => {
    await offerSlugs('ref-hit', [SLUG]);
    expect(record).toHaveBeenCalledTimes(1);

    recordInjectionReference({
      agentId: 'agent-ref',
      sessionKey: 'ref-hit',
      toolName: 'knowledge_get',
      refs: [SLUG],
    });

    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls[1]![0]).toBe('memory.injection.referenced');
    expect(record.mock.calls[1]![1]).toEqual({
      lane: 'knowledge',
      toolName: 'knowledge_get',
      knowledgeSlugs: [SLUG],
      memoryIds: [],
      messageIds: [],
    });

    // Reading the same page again is not a second reference.
    recordInjectionReference({
      agentId: 'agent-ref',
      sessionKey: 'ref-hit',
      toolName: 'knowledge_get',
      refs: [SLUG],
    });
    expect(record).toHaveBeenCalledTimes(2);
  });

  it('ignores a read of a page that was never offered', async () => {
    await offerSlugs('ref-miss', [SLUG]);

    recordInjectionReference({
      agentId: 'agent-ref',
      sessionKey: 'ref-miss',
      toolName: 'knowledge_get',
      refs: ['topic/never-injected'],
    });

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0]).toBe('memory.injection');
  });

  it('matches a page-type-prefixed ref to the bare offered slug', async () => {
    // `titlesForInjection` may hand over a bare slug while the model reads the
    // page with its type prefix (or the other way round): same page.
    await offerSlugs('ref-bare', ['excel-etl']);

    recordInjectionReference({
      agentId: 'agent-ref',
      sessionKey: 'ref-bare',
      toolName: 'knowledge_get',
      refs: ['topic/excel-etl'],
    });

    expect(record.mock.calls[1]![0]).toBe('memory.injection.referenced');
    expect(record.mock.calls[1]![1]).toEqual({
      lane: 'knowledge',
      toolName: 'knowledge_get',
      knowledgeSlugs: ['excel-etl'],
      memoryIds: [],
      messageIds: [],
    });
  });

  it('does not credit an offer from another session', async () => {
    await offerSlugs('ref-owner', [SLUG]);

    recordInjectionReference({
      agentId: 'agent-ref',
      sessionKey: 'ref-other',
      toolName: 'knowledge_get',
      refs: [SLUG],
    });

    expect(record).toHaveBeenCalledTimes(1);
  });

  it('records a reference for the memory lane, with that lane of ids', async () => {
    // Only the knowledge lane has an in-repo reader (`knowledge_get`), so this
    // drives the generalized seam the way a memory-reading consumer would: the
    // offer published by the build is matched, consumed, and reported per lane.
    const retriever = {
      retrieveGrouped: async () => [
        {
          id: 'mem-ref',
          content: '偏好简洁回复',
          scope: 'user',
          kind: 'preference',
          score: 0.8,
          createdAt: 1,
        },
      ],
      retrieve: async () => [],
    } as unknown as MemoryRetriever;
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'ref-memory',
      agentId: 'agent-ref',
      memoryRetriever: retriever,
    });
    await transform([{ role: 'user', content: NEUTRAL_QUERY }]);

    recordInjectionReference({
      agentId: 'agent-ref',
      sessionKey: 'ref-memory',
      toolName: 'memory_recall',
      lane: 'memories',
      refs: ['mem-ref'],
    });

    expect(record.mock.calls[1]![0]).toBe('memory.injection.referenced');
    expect(record.mock.calls[1]![1]).toEqual({
      lane: 'memories',
      toolName: 'memory_recall',
      knowledgeSlugs: [],
      memoryIds: ['mem-ref'],
      messageIds: [],
    });

    // Consumed: the same id cannot be credited twice from one offer.
    recordInjectionReference({
      agentId: 'agent-ref',
      sessionKey: 'ref-memory',
      toolName: 'memory_recall',
      lane: 'memories',
      refs: ['mem-ref'],
    });
    expect(record).toHaveBeenCalledTimes(2);
  });

  it('records a reference for the messages lane, with the excerpt ids', async () => {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'ref-messages',
      episodicContextProvider: () => [{ ...episodicItems(1)[0]!, messageId: 'msg-ref' }],
    });
    await transform([{ role: 'user', content: RECALL_QUERY }]);

    recordInjectionReference({
      sessionKey: 'ref-messages',
      toolName: 'session_search',
      lane: 'messages',
      refs: ['msg-ref'],
    });

    expect(record.mock.calls[1]![1]).toEqual({
      lane: 'messages',
      toolName: 'session_search',
      knowledgeSlugs: [],
      memoryIds: [],
      messageIds: ['msg-ref'],
    });
  });

  it('does not credit an id that the lane did not offer', async () => {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'ref-unnamed',
      episodicContextProvider: () => [{ ...episodicItems(1)[0]!, messageId: 'msg-offered' }],
    });
    await transform([{ role: 'user', content: RECALL_QUERY }]);

    recordInjectionReference({
      sessionKey: 'ref-unnamed',
      toolName: 'session_search',
      lane: 'messages',
      refs: ['msg-never-offered'],
    });

    expect(record.mock.calls.map((call) => call[0])).toEqual(['memory.injection']);
  });

  it('forgets an offer the registry has evicted', async () => {
    // The offer registry is one bounded LRU entry per session (max 2000) with a
    // 15-minute TTL: what a long-lived gateway remembers must not grow with the
    // number of sessions it has ever served. Session 0's offer is what has to be
    // gone by the time 2000 newer sessions have replaced it.
    await offerSlugs('ref-bound-0', [SLUG]);
    for (let index = 1; index <= 2000; index++) {
      await offerSlugs(`ref-bound-${index}`, [SLUG]);
    }

    const before = record.mock.calls.length;
    recordInjectionReference({
      agentId: 'agent-ref',
      sessionKey: 'ref-bound-0',
      toolName: 'knowledge_get',
      refs: [SLUG],
    });

    expect(record.mock.calls.length).toBe(before);
  });

  it('drops the offer on a build that offered nothing', async () => {
    await offerSlugs('ref-cleared', [SLUG]);

    // Next build of the same session offers no page at all.
    await offerSlugs('ref-cleared', []);
    recordInjectionReference({
      agentId: 'agent-ref',
      sessionKey: 'ref-cleared',
      toolName: 'knowledge_get',
      refs: [SLUG],
    });

    // The old offer must not be credited to a later tool call.
    expect(record.mock.calls.map((call) => call[0])).toEqual(['memory.injection']);
  });
});

/**
 * The turn-end reader (plan §6 K0 item 3, ②「是否被引用」) for the lanes that
 * have no tool to read them back.
 *
 * `knowledge_get` proves the knowledge lane was used, because reading a page by
 * slug is proof. A memory or an excerpt has no such tool: the only evidence is
 * the answer itself, and the transform returns before the answer exists, so the
 * check runs at turn end (`agent-service`'s `turn_end` listener).
 *
 * The rule under test is a literal-quote rule, deliberately conservative: an
 * item counts when a distinctive clause of the injected text appears in the
 * answer. A word both sides happen to share is not evidence, a paraphrase is not
 * evidence, and a false "it was used" is the failure mode worth a test — the
 * metric exists to say something true, not to say something often.
 */
describe('turn-end reference reading', () => {
  let record: ReturnType<typeof vi.spyOn>;

  /** A clause of the injected memory, and an answer that quotes it. */
  const MEMORY_CONTENT = '用户偏好简洁回复，不要长篇大论';
  const MEMORY_QUOTE = '当然，你说过不要长篇大论，这里直接说结论。';
  const MEMORY_UNRELATED = '这里直接说结论：TypeScript 的快速排序带注释。';

  const EPISODIC_EXCERPT = '上次那个 ETL 脚本放在 /srv/etl 下，批量替换用的是 Python';
  const EPISODIC_QUOTE = '按你上次说的，批量替换用的是 Python，脚本还在 /srv/etl 里。';

  beforeEach(() => {
    record = vi.spyOn(memoryObservability, 'record');
  });

  afterEach(() => {
    record.mockRestore();
  });

  /** The emitted `memory.injection.referenced` payloads, in order. */
  function referenced(): Array<Record<string, any>> {
    return record.mock.calls
      .filter((call) => call[0] === 'memory.injection.referenced')
      .map((call) => (call[1] ?? {}) as Record<string, any>);
  }

  function memoryRetrieverReturning(content: string, id: string): MemoryRetriever {
    return {
      retrieveGrouped: async () => [
        { id, content, scope: 'user', kind: 'preference', score: 0.9, createdAt: 1 },
      ],
      retrieve: async () => [],
    } as unknown as MemoryRetriever;
  }

  /**
   * Drive the prompt build that offers the item. Note that the build is told the
   * agent id but the reader is not — the session's published scope key is what
   * the reader resolves, which is the only way it can work from agent-service
   * (the effective agent id is resolved inside the factory).
   */
  async function buildMemoryPrompt(sessionKey: string, content: string, id: string): Promise<void> {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey,
      agentId: 'agent-turn-end',
      memoryRetriever: memoryRetrieverReturning(content, id),
    });
    await transform([{ role: 'user', content: NEUTRAL_QUERY }]);
  }

  async function buildEpisodicPrompt(sessionKey: string): Promise<void> {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey,
      agentId: 'agent-turn-end',
      episodicContextProvider: () => [
        {
          createdAt: Date.UTC(2026, 9, 8),
          channel: 'feishu',
          sessionTitle: '脚本检查',
          role: 'user',
          excerpt: EPISODIC_EXCERPT,
          messageId: 'msg-quote',
        },
      ],
    });
    await transform([{ role: 'user', content: RECALL_QUERY }]);
  }

  it('credits a memory the answer quotes', async () => {
    await buildMemoryPrompt('turn-end-memory-hit', MEMORY_CONTENT, 'mem-quote');

    readInjectionReferences({ sessionKey: 'turn-end-memory-hit', answerText: MEMORY_QUOTE });

    expect(referenced()).toEqual([
      {
        lane: 'memories',
        toolName: 'assistant_message',
        knowledgeSlugs: [],
        memoryIds: ['mem-quote'],
        messageIds: [],
      },
    ]);
  });

  it('credits nothing when the answer never quotes the injected memory', async () => {
    await buildMemoryPrompt('turn-end-memory-miss', MEMORY_CONTENT, 'mem-quote');

    readInjectionReferences({ sessionKey: 'turn-end-memory-miss', answerText: MEMORY_UNRELATED });

    expect(referenced()).toEqual([]);
  });

  it('credits an episodic excerpt the answer quotes, under the message lane', async () => {
    await buildEpisodicPrompt('turn-end-episodic-hit');

    readInjectionReferences({ sessionKey: 'turn-end-episodic-hit', answerText: EPISODIC_QUOTE });

    expect(referenced()).toEqual([
      {
        lane: 'messages',
        toolName: 'assistant_message',
        knowledgeSlugs: [],
        memoryIds: [],
        messageIds: ['msg-quote'],
      },
    ]);
  });

  it('never credits a shared word, however often the answer uses it', async () => {
    // The memory is one term. The answer is about that term. Neither is proof
    // that the injected line was read, and crediting it would make the metric a
    // lie — so a single word is not a fragment in the first place.
    await buildMemoryPrompt('turn-end-word', 'Excel', 'mem-word');

    readInjectionReferences({
      sessionKey: 'turn-end-word',
      answerText: '我用 Excel 处理这张表，Excel 的 Power Query 就够了，Excel 很方便。',
    });

    expect(referenced()).toEqual([]);
  });

  it('credits each offer once, and only while the registry still holds it', async () => {
    const now = vi.spyOn(performance, 'now');
    try {
      // Not 0: the LRU treats a zero start timestamp as "no TTL recorded".
      now.mockReturnValue(1_000);
      await buildMemoryPrompt('turn-end-ttl', MEMORY_CONTENT, 'mem-ttl');

      readInjectionReferences({ sessionKey: 'turn-end-ttl', answerText: MEMORY_QUOTE });
      expect(referenced()).toHaveLength(1);

      // Consumed: a second read of the same answer is not a second reference.
      readInjectionReferences({ sessionKey: 'turn-end-ttl', answerText: MEMORY_QUOTE });
      expect(referenced()).toHaveLength(1);

      // A later build offers it again, and the 15-minute TTL is what bounds how
      // long anything can be credited to that build.
      await buildMemoryPrompt('turn-end-ttl', MEMORY_CONTENT, 'mem-ttl');
      now.mockReturnValue(1_000 + 16 * 60_000);
      // The registry debounces its clock reads for 1 ms, so the jump has to
      // outlive that debounce or the stale cached reading is used.
      await new Promise((resolve) => setTimeout(resolve, 10));
      readInjectionReferences({ sessionKey: 'turn-end-ttl', answerText: MEMORY_QUOTE });
      expect(referenced()).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });

  it('is a no-op for a session that injected nothing', async () => {
    readInjectionReferences({
      sessionKey: 'turn-end-no-injection',
      answerText: MEMORY_QUOTE,
    });

    expect(referenced()).toEqual([]);
    expect(record).not.toHaveBeenCalled();
  });

  it('survives an empty answer and bounds the scan of an enormous one', async () => {
    await buildMemoryPrompt('turn-end-size', MEMORY_CONTENT, 'mem-size');

    expect(() =>
      readInjectionReferences({ sessionKey: 'turn-end-size', answerText: '' }),
    ).not.toThrow();
    expect(referenced()).toEqual([]);

    // The scan is capped (20 KB): a quote past the window is not counted, and
    // an enormous answer costs the same as a short one.
    const enormous = `${'填充'.repeat(20_000)}${MEMORY_QUOTE}`;
    expect(() =>
      readInjectionReferences({ sessionKey: 'turn-end-size', answerText: enormous }),
    ).not.toThrow();
    expect(referenced()).toEqual([]);
  });
});

/**
 * Graph hints: the one prompt-facing consumer of `entity_edges` that is not an
 * injected block.
 *
 * `memory_recall` appends `A —USES→ B [mem:xxxxxxxx]` to its own tool result,
 * so the probe cannot read the hint out of an offer list — the tool publishes it
 * (`recordInjectedGraphHints`) and the turn-end reader scores it. A hint is a
 * statement about a pair, so the rule is stricter than the memory lane's: the
 * answer has to contain the neighbour's name AND the relation word. A name
 * alone, or a paraphrase that replaces the relation with its meaning, is not
 * evidence that the hint was read.
 */
describe('turn-end reference reading — graph hints', () => {
  let record: ReturnType<typeof vi.spyOn>;

  const HINT = {
    subject: 'excel-mcp',
    relation: 'USES',
    object: 'Power Query',
    memoryId: 'mem-edge-1',
    memoryRef: 'mem-edge',
  };

  beforeEach(() => {
    record = vi.spyOn(memoryObservability, 'record');
  });

  afterEach(() => {
    record.mockRestore();
  });

  function referenced(): Array<Record<string, any>> {
    return record.mock.calls
      .filter((call) => call[0] === 'memory.injection.referenced')
      .map((call) => (call[1] ?? {}) as Record<string, any>);
  }

  it('credits the hint when the answer repeats the neighbour and the relation', () => {
    recordInjectedGraphHints({ sessionKey: 'graph-literal', hints: [HINT] });

    readInjectionReferences({
      sessionKey: 'graph-literal',
      answerText: '结论：excel-mcp —USES→ Power Query，也就是 excel-mcp 用 Power Query 读表。',
    });

    expect(referenced()).toEqual([
      {
        lane: 'graph',
        toolName: 'assistant_message',
        knowledgeSlugs: [],
        memoryIds: ['mem-edge-1'],
        messageIds: [],
      },
    ]);
  });

  it('does not credit a paraphrase that names the neighbour without the relation', () => {
    recordInjectedGraphHints({ sessionKey: 'graph-paraphrase', hints: [HINT] });

    readInjectionReferences({
      sessionKey: 'graph-paraphrase',
      answerText: 'excel-mcp 靠着 Power Query 就能把文件名和行数读出来。',
    });

    expect(referenced()).toEqual([]);
  });

  it('does not credit the relation word without the neighbour', () => {
    recordInjectedGraphHints({ sessionKey: 'graph-lonely-relation', hints: [HINT] });

    readInjectionReferences({
      sessionKey: 'graph-lonely-relation',
      answerText: 'excel-mcp uses 了别的办法，和这张表无关。',
    });

    expect(referenced()).toEqual([]);
  });

  it('survives an empty answer, and the hint can still be credited afterwards', () => {
    recordInjectedGraphHints({ sessionKey: 'graph-empty', hints: [HINT] });

    expect(() =>
      readInjectionReferences({ sessionKey: 'graph-empty', answerText: '' }),
    ).not.toThrow();
    expect(referenced()).toEqual([]);

    // Nothing was consumed by the empty answer, so the next one is still scored.
    readInjectionReferences({
      sessionKey: 'graph-empty',
      answerText: 'excel-mcp —USES→ Power Query 是图里唯一的边。',
    });
    expect(referenced()).toHaveLength(1);
  });

  it('credits a hint once per offer', () => {
    recordInjectedGraphHints({ sessionKey: 'graph-once', hints: [HINT] });
    const answer = 'excel-mcp —USES→ Power Query，只此一条。';

    readInjectionReferences({ sessionKey: 'graph-once', answerText: answer });
    readInjectionReferences({ sessionKey: 'graph-once', answerText: answer });

    expect(referenced()).toHaveLength(1);
  });

  it('ignores a hint whose relation or neighbour normalises to nothing', () => {
    recordInjectedGraphHints({
      sessionKey: 'graph-blank',
      hints: [{ ...HINT, object: '   ' }],
    });

    readInjectionReferences({
      sessionKey: 'graph-blank',
      answerText: 'excel-mcp USES 任何东西。',
    });

    expect(referenced()).toEqual([]);
  });
});

/**
 * The knowledge block is read in the turn's scope (migration-v22).
 *
 * This block is the most visible form of the leak the scope column exists for:
 * it is built on every turn, so a page curated in one group chat being offered
 * as a title in another is not an edge case but the normal state of an install
 * with several chats.
 *
 * What is under test here is the wiring — the transform resolving the turn's
 * scope and the provider passing it on — not the scope model itself
 * (`tests/memory/migration-v22.test.ts`) and not the ranking
 * (`tests/knowledge/scope-isolation.test.ts`):
 *
 * - a page written in chat A is offered in chat A and never in chat B;
 * - a `global` page is offered in both;
 * - a turn with no conversation identity (the console, cron, an install that
 *   passes nothing) still asks with no scope at all, so it keeps seeing every
 *   page — the behaviour it had before pages had scopes;
 * - the ≤150-token knowledge and ≤250-token episodic caps are unchanged.
 */
describe("knowledge injection in the turn's scope", () => {
  const DEPLOY_QUERY = 'deploy checklist';

  let db: Database.Database;
  let service: KnowledgeService;

  beforeEach(() => {
    db = openSeededDatabase();
    service = createKnowledgeService({ db });
  });

  afterEach(() => {
    db.close();
  });

  /** The factory's wiring, minus its config gate: the transform supplies the scope. */
  function scopedProvider(max = 2) {
    return vi.fn((query: string, scope?: string) =>
      service.titlesForInjection(query, max, { scope }),
    );
  }

  function writePage(slug: string, scope: string, content?: string): void {
    const result = service.create(
      {
        pageType: 'topic',
        slug,
        title: 'Deploy checklist',
        content: content ?? 'Deploy checklist: run the release script.',
        sources: TWO_MEMORY_SOURCES,
      },
      { actor: 'agent', scope },
    );
    expect(result.ok).toBe(true);
  }

  async function injectedBlocks(options: {
    sessionKey?: string;
    channel?: string;
    chatId?: string;
    query?: string;
    provider: (query: string, scope?: string) => KnowledgeContextItem[] | undefined;
    episodic?: EpisodicContextItem[];
  }): Promise<string[]> {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: options.sessionKey,
      channel: options.channel,
      chatId: options.chatId,
      episodicContextProvider: options.episodic ? () => options.episodic! : undefined,
      knowledgeContextProvider: options.provider,
    });
    const result = await transform([{ role: 'user', content: options.query ?? DEPLOY_QUERY }]);
    return textBlocks(result[0]!.content);
  }

  function knowledgeBlockOf(blocks: string[]): string {
    return blocks.find((text) => text.includes('<knowledge_available>')) ?? '';
  }

  it("offers chat A's page in chat A and never in chat B", async () => {
    writePage('deploy-a', 'feishu:oc_a');
    writePage('deploy-b', 'telegram:42');

    const inA = scopedProvider();
    const blockA = knowledgeBlockOf(
      await injectedBlocks({
        sessionKey: 'scope-chat-a',
        channel: 'feishu',
        chatId: 'oc_a',
        provider: inA,
      }),
    );
    expect(inA.mock.calls[0]![1]).toBe('feishu:oc_a');
    expect(blockA).toContain('deploy-a — Deploy checklist');
    expect(blockA).not.toContain('deploy-b');

    const inB = scopedProvider();
    const blockB = knowledgeBlockOf(
      await injectedBlocks({
        sessionKey: 'scope-chat-b',
        channel: 'telegram',
        chatId: '42',
        provider: inB,
      }),
    );
    expect(inB.mock.calls[0]![1]).toBe('telegram:42');
    expect(blockB).toContain('deploy-b — Deploy checklist');
    expect(blockB).not.toContain('deploy-a');
  });

  it('offers a global page to both chats', async () => {
    writePage('deploy-a', 'feishu:oc_a');
    writePage('deploy-global', 'global');

    const blockA = knowledgeBlockOf(
      await injectedBlocks({
        sessionKey: 'scope-global-a',
        channel: 'feishu',
        chatId: 'oc_a',
        provider: scopedProvider(),
      }),
    );
    expect(blockA).toContain('deploy-a — Deploy checklist');
    expect(blockA).toContain('deploy-global — Deploy checklist');

    const blockB = knowledgeBlockOf(
      await injectedBlocks({
        sessionKey: 'scope-global-b',
        channel: 'telegram',
        chatId: '42',
        provider: scopedProvider(),
      }),
    );
    expect(blockB).toContain('deploy-global — Deploy checklist');
    expect(blockB).not.toContain('deploy-a');
  });

  it('keeps the console and an identity-less turn unscoped, and they still see every page', async () => {
    writePage('deploy-a', 'feishu:oc_a');
    writePage('deploy-b', 'telegram:42');

    // The WebUI chat carries channel `webui` and chatId `webui:<project>`; the
    // console is not a conversation, so the ask stays unscoped and unchanged.
    const consoleProvider = scopedProvider();
    const consoleBlock = knowledgeBlockOf(
      await injectedBlocks({
        sessionKey: 'scope-console',
        channel: 'webui',
        chatId: 'webui:proj-1',
        provider: consoleProvider,
      }),
    );
    expect(consoleProvider.mock.calls[0]![1]).toBeUndefined();
    expect(consoleBlock).toContain('deploy-a');
    expect(consoleBlock).toContain('deploy-b');

    // A turn that passes no identity at all (cron, a programmatic caller) asks
    // the same way — `undefined` is "every scope", not "globals only".
    const anonymous = scopedProvider();
    const anonymousBlock = knowledgeBlockOf(await injectedBlocks({ provider: anonymous }));
    expect(anonymous.mock.calls[0]![1]).toBeUndefined();
    expect(anonymousBlock).toContain('deploy-a');
    expect(anonymousBlock).toContain('deploy-b');
  });

  it('keeps the per-lane token caps while the scope narrows the candidate set', async () => {
    writePage('deploy-a', 'feishu:oc_a', '批量替换脚本用 python 跑，结果写到 out 目录。');
    writePage('deploy-b', 'telegram:42');

    const blocks = await injectedBlocks({
      sessionKey: 'scope-caps',
      channel: 'feishu',
      chatId: 'oc_a',
      query: RECALL_QUERY,
      provider: scopedProvider(),
      episodic: episodicItems(3),
    });

    const knowledge = knowledgeBlockOf(blocks);
    const episodic = blocks.find((text) => text.includes('<recent_conversation>')) ?? '';
    expect(knowledge).toContain('deploy-a');
    expect(knowledge).not.toContain('deploy-b');
    expect(estimateTokensForText(knowledge)).toBeLessThanOrEqual(150);
    expect(estimateTokensForText(episodic)).toBeLessThanOrEqual(250);
  });
});
