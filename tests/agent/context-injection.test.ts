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
    expect(record.mock.calls[1]![1]).toEqual({ knowledgeSlugs: [SLUG], toolName: 'knowledge_get' });

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
      knowledgeSlugs: ['excel-etl'],
      toolName: 'knowledge_get',
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
