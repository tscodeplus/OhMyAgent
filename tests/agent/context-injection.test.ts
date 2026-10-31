/**
 * Per-turn episodic (`<recent_conversation>`, plan §6 K1-4) injection.
 *
 * The properties under test are the ones that decide whether these blocks are
 * safe to leave on by default:
 *
 * - **undefined provider = today's behaviour.** The option is opt-in, so a
 *   deployment that never wires it must produce byte-identical context.
 * - **budget.** 2 items × ≤200 chars inside the plan's ≤400-token per-turn
 *   automatic-injection increment (G4).
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
  recordInjectionReference,
} from '../../src/agent/context-transform.js';
import type { EpisodicContextItem } from '../../src/agent/context-transform.js';
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

describe('per-turn episodic injection', () => {
  it('leaves the turn untouched when neither provider is configured', async () => {
    const transform = createTransformContext({ maxMessages: 5, sessionKey: 'inject-off' });

    const messages = [{ role: 'user', content: RECALL_QUERY }];
    const result = await transform(messages);

    expect(result).toEqual([{ role: 'user', content: RECALL_QUERY }]);
    expect(joined(result[0]!.content)).not.toContain('<recent_conversation>');
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

  it('omits a block whose provider returns nothing', async () => {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'inject-empty-providers',
      episodicContextProvider: () => [],
    });

    const result = await transform([{ role: 'user', content: RECALL_QUERY }]);
    const text = joined(result[0]!.content);

    expect(text).not.toContain('<recent_conversation>');
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

  it('appends the episodic block, then persona after the user text', async () => {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'inject-block-order',
      episodicContextProvider: () => episodicItems(1),
      personaContextProvider: () => '[用户画像]\n偏好简洁回复',
    });

    const result = await transform([{ role: 'user', content: RECALL_QUERY }]);
    const text = joined(result[0]!.content);

    expect(text.startsWith(RECALL_QUERY)).toBe(true);
    expect(text.indexOf('<recent_conversation>')).toBeGreaterThan(0);
    // Persona is last by design: the current preference must override any stale
    // name or fact carried by the retrieved block above it.
    expect(text.indexOf('<persona>')).toBeGreaterThan(text.indexOf('</recent_conversation>'));
  });

  it('keeps the injected increment within the 400-token plan limit', async () => {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'inject-combined-budget',
      episodicContextProvider: () => episodicItems(2),
    });

    const result = await transform([{ role: 'user', content: RECALL_QUERY }]);
    const injected = textBlocks(result[0]!.content)
      .filter((text) => text.includes('<recent_conversation>'))
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
    expect(details.itemCounts).toEqual({ memories: 0, messages: 2 });
    expect(details.estimatedTokens.messages).toBeGreaterThan(0);
    expect(details.estimatedTokens.total).toBe(details.estimatedTokens.messages);
    expect(details.latencyMs.messages).toBeGreaterThanOrEqual(0);
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
    expect(details.itemCounts).toEqual({ memories: 1, messages: 0 });
    expect(details.estimatedTokens.memories).toBeGreaterThan(0);
    expect(details.status).toBe('ok');
  });

  it('marks the turn degraded when a lane throws, and still completes it', async () => {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'telemetry-degraded',
      episodicContextProvider: () => [{ ...episodicItems(1)[0]!, messageId: 'msg-kept' }],
      memoryRetriever: {
        retrieveGrouped: async () => {
          throw new Error('vector store down');
        },
        retrieve: async () => {
          throw new Error('vector store down');
        },
      } as unknown as MemoryRetriever,
      agentId: 'agent-degraded',
    });

    const result = await transform([{ role: 'user', content: RECALL_QUERY }]);
    const details = injectedDetails();

    // The episodic lane still answered; only the memory lane degraded.
    expect(joined(result[0]!.content)).toContain('<recent_conversation>');
    expect(details.messageIds).toEqual(['msg-kept']);
    expect(details.itemCounts).toEqual({ memories: 0, messages: 1 });
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
    });

    const result = await transform([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
      { role: 'user', content: RECALL_QUERY },
    ]);
    const details = injectedDetails();

    expect(result).toHaveLength(3);
    expect(details.itemCounts).toEqual({ memories: 1, messages: 1 });
    expect(details.memoryIds).toEqual(['mem-1']);
    expect(details.messageIds).toEqual(['msg-prev']);
    expect(details.estimatedTokens.total).toBe(
      details.estimatedTokens.memories + details.estimatedTokens.messages,
    );
    expect(details.estimatedTokens.total).toBeGreaterThan(details.estimatedTokens.memories);
    expect(details.status).toBe('ok');
  });
});

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

describe('memory lane inside the shared injection budget (§8 S5)', () => {
  let record: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    record = vi.spyOn(memoryObservability, 'record');
  });
  afterEach(() => {
    record.mockRestore();
  });

  function lastInjectionDetails(): Record<string, any> {
    const calls = record.mock.calls.filter((call) => call[0] === 'memory.injection');
    expect(calls.length).toBeGreaterThan(0);
    return (calls[calls.length - 1]![1] ?? {}) as Record<string, any>;
  }

  function memoryRetrieverReturning(memories: RetrievedMemory[]): MemoryRetriever {
    return {
      retrieveGrouped: async () => memories,
      retrieve: async () => memories,
    } as unknown as MemoryRetriever;
  }

  /** Recalled memories as the snapshot lane sees them: RRF-scale scores. */
  function recalls(contents: string[]): RetrievedMemory[] {
    return contents.map((content, index) => ({
      id: `mem-${index}`,
      content,
      scope: 'user',
      kind: 'fact',
      // Deliberately the RRF magnitude the real retriever reports (~1/61): the
      // lane must not be compared on this number against a BM25 score.
      score: 1 / (61 + index),
      createdAt: Date.UTC(2026, 9, 1),
    }));
  }

  const EXCERPT: EpisodicContextItem[] = [
    {
      createdAt: Date.UTC(2026, 9, 8),
      channel: 'feishu',
      role: 'user',
      excerpt: '上次那个 ETL 脚本放在 /srv/etl 下',
      messageId: 'msg-pool',
    },
  ];

  it('counts the memory block in the same pool as the episodic lane', async () => {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'pool-memory-counted',
      agentId: 'agent-1',
      injectionBudget: { totalTokens: 10_000 },
      memoryRetriever: memoryRetrieverReturning(recalls(['偏好简洁回复，不要长篇大论'])),
      episodicContextProvider: () => EXCERPT,
    });

    const result = await transform([{ role: 'user', content: RECALL_QUERY }]);
    const text = joined(result[0]!.content);
    const details = lastInjectionDetails();

    expect(text).toContain('<memory_context>');
    // Pre-K5-4 block order is unchanged: memories first, then the other lanes.
    expect(text.indexOf('<memory_context>')).toBeLessThan(text.indexOf('<recent_conversation>'));
    expect(details.itemCounts).toEqual({ memories: 1, messages: 1 });
    expect(details.memoryIds).toEqual(['mem-0']);
    expect(details.estimatedTokens.memories).toBeGreaterThan(0);
    expect(details.estimatedTokens.total).toBe(
      details.estimatedTokens.memories + details.estimatedTokens.messages,
    );
  });

  it('drops the memory block when the pool is already spent', async () => {
    // An excerpt-only build, measured with the same estimator the transform uses.
    const excerptOnly = createTransformContext({
      maxMessages: 5,
      sessionKey: 'pool-measure-excerpt',
      injectionBudget: { totalTokens: 10_000 },
      episodicContextProvider: () => EXCERPT,
    });
    const excerptBlock = textBlocks(
      (await excerptOnly([{ role: 'user', content: RECALL_QUERY }]))[0]!.content,
    ).find((block) => block.includes('<recent_conversation>'))!;
    const totalTokens = Math.ceil(estimateTokensForText(excerptBlock));

    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'pool-memory-loses',
      agentId: 'agent-1',
      injectionBudget: { totalTokens },
      memoryRetriever: memoryRetrieverReturning(recalls(['长'.repeat(600)])),
      episodicContextProvider: () => [{ ...EXCERPT[0]!, score: 1 }],
    });

    const result = await transform([{ role: 'user', content: RECALL_QUERY }]);
    const text = joined(result[0]!.content);
    const details = lastInjectionDetails();

    // The excerpt fits the pool, the (larger) memory block does not — before S5
    // the memory block was appended regardless of any budget.
    expect(text).toContain('<recent_conversation>');
    expect(text).not.toContain('<memory_context>');
    expect(details.itemCounts).toEqual({ memories: 0, messages: 1 });
    expect(details.estimatedTokens.memories).toBe(0);
    expect(details.estimatedTokens.total).toBeLessThanOrEqual(totalTokens);
  });

  it('honours a per-lane memory ceiling from configuration', async () => {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'pool-memory-ceiling',
      agentId: 'agent-1',
      injectionBudget: { totalTokens: 10_000, memoryTokens: 1 },
      memoryRetriever: memoryRetrieverReturning(recalls(['偏好简洁回复，不要长篇大论'])),
      episodicContextProvider: () => EXCERPT,
    });

    const text = joined((await transform([{ role: 'user', content: RECALL_QUERY }]))[0]!.content);

    expect(text).not.toContain('<memory_context>');
    expect(text).toContain('<recent_conversation>');
  });
});
