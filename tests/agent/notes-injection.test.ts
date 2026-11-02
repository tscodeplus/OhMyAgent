/**
 * Per-turn notes injection (`<notes_context>`, MyDocs/NOTES_LAYER_REVIEW_2026-11-02.md
 * §4 U1).
 *
 * The notes layer could be written to (capture → draft → human review) and read
 * back only by a human scrolling the WebUI. This is the second half of the read
 * path: the same two-note, one-block shape as `<recent_conversation>`, spent from
 * the same per-turn injection pool.
 *
 * The properties under test are the ones that decide whether the block is safe to
 * leave on:
 *
 * - **a back-reference, not every turn.** "上次那个命令" asks about something
 *   written down; "写一个排序函数" does not, and must not pay for the block.
 * - **two notes, title + summary, ≤400 tokens** — a note is distilled prose, so
 *   two of them are an answer and a third is context nobody asked for.
 * - **the mode is stated.** A query with no searchable words falls back to the
 *   newest notes, and the block says so: a model that reads a shelf as a match
 *   answers last week's question from this week's note.
 * - **failure is a no-op.** A provider that throws leaves the turn exactly as it
 *   would have been — the iron rule of every lane in this module.
 */

import { describe, it, expect, vi } from 'vitest';
import { createTransformContext } from '../../src/agent/context-transform.js';
import type { NotesContextOffer } from '../../src/agent/context-transform.js';
import { searchNotesContext } from '../../src/agent/agent-factory.js';
import type { MemoryRetriever, RetrievedMemory } from '../../src/memory/memory-retriever.js';
import { memoryObservability } from '../../src/memory/observability.js';
import { estimateTokensForText } from '../../src/shared/token-estimate.js';
import { openDatabase } from '../../src/memory/db.js';
import { createTestService } from '../notes/fixtures.js';
import type { Note, NoteListQuery, NoteListResult } from '../../src/notes/types.js';
import type { NotesService } from '../../src/notes/service-contract.js';

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

function notesBlock(content: unknown): string | undefined {
  return textBlocks(content).find((text) => text.includes('<notes_context>'));
}

/** Rendered entries: one `- title — summary` line each. */
function noteEntryCount(block: string): number {
  return block.split('\n').filter((line) => line.startsWith('- ')).length;
}

const RECALL_QUERY = '上次那个批量替换脚本用的什么命令？';
const NEUTRAL_QUERY = '写一个 TypeScript 的快速排序函数，带注释';

function offer(mode: NotesContextOffer['mode'], count: number): NotesContextOffer {
  return {
    mode,
    items: Array.from({ length: count }, (_, index) => ({
      id: `note-${index}`,
      title: `第${index}条笔记`,
      // Far past the 200-char line cap: the transform owns that cap, not the provider.
      summary: `第${index}条摘要 `.repeat(60),
    })),
  };
}

describe('per-turn notes injection', () => {
  it('injects at most 2 approved notes for a back-reference', async () => {
    const provider = vi.fn(() => offer('matched', 3));
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'notes-inject-budget',
      notesContextProvider: provider,
    });

    const result = await transform([{ role: 'user', content: RECALL_QUERY }]);
    const block = notesBlock(result[0]!.content)!;

    expect(provider).toHaveBeenCalledWith(RECALL_QUERY);
    expect(block).toContain('</notes_context>');
    expect(noteEntryCount(block)).toBe(2);
    // Best-first: the third note is the one dropped.
    expect(block).toContain('第0条笔记');
    expect(block).not.toContain('第2条笔记');
    // Title + summary only — the body is what `notes_search` is for.
    expect(block).not.toContain('body');
    expect(estimateTokensForText(block)).toBeLessThanOrEqual(400);
  });

  it('does not inject the block when the turn is not a back-reference', async () => {
    const provider = vi.fn(() => offer('matched', 2));
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'notes-inject-gate',
      notesContextProvider: provider,
    });

    const result = await transform([{ role: 'user', content: NEUTRAL_QUERY }]);

    expect(provider).not.toHaveBeenCalled();
    expect(joined(result[0]!.content)).not.toContain('<notes_context>');
  });

  it('says which mode it is in, in words', async () => {
    // A fallback list under a "relevant notes" header is a wrong answer dressed
    // as a right one: the entries cannot tell the two apart, the header can.
    const recent = createTransformContext({
      maxMessages: 5,
      sessionKey: 'notes-inject-recent-header',
      notesContextProvider: () => offer('recent', 1),
    });
    const matched = createTransformContext({
      maxMessages: 5,
      sessionKey: 'notes-inject-matched-header',
      notesContextProvider: () => offer('matched', 1),
    });

    const recentBlock = notesBlock(
      (await recent([{ role: 'user', content: RECALL_QUERY }]))[0]!.content,
    )!;
    const matchedBlock = notesBlock(
      (await matched([{ role: 'user', content: RECALL_QUERY }]))[0]!.content,
    )!;

    expect(recentBlock).toContain('not search results');
    expect(matchedBlock).toContain('relevant to this message');
    expect(matchedBlock).not.toContain('not search results');
  });

  it('omits a block whose provider returns nothing', async () => {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'notes-inject-empty',
      notesContextProvider: () => undefined,
    });

    const result = await transform([{ role: 'user', content: RECALL_QUERY }]);

    expect(joined(result[0]!.content)).not.toContain('<notes_context>');
  });

  it('leaves the turn untouched when the layer is off (no provider)', async () => {
    // `notes.enabled: false` removes the service, which removes the provider.
    const transform = createTransformContext({ maxMessages: 5, sessionKey: 'notes-inject-off' });

    const result = await transform([{ role: 'user', content: RECALL_QUERY }]);

    expect(result).toEqual([{ role: 'user', content: RECALL_QUERY }]);
    expect(joined(result[0]!.content)).not.toContain('<notes_context>');
  });

  it('keeps the turn intact when the notes provider throws', async () => {
    const logger = { debug: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'notes-inject-throws',
      logger,
      notesContextProvider: () => {
        throw new Error('nearby search failed');
      },
    });

    const result = await transform([{ role: 'user', content: RECALL_QUERY }]);

    expect(result).toEqual([{ role: 'user', content: RECALL_QUERY }]);
    expect(joined(result[0]!.content)).not.toContain('<notes_context>');
    expect(logger.debug).toHaveBeenCalledWith(
      'Notes context injection failed — continuing without it',
    );
  });

  it('spends from the same pool as the other two lanes', async () => {
    // One pool, one ranking pass: the notes block may not add tokens on top of
    // the ≤800 the memory and episodic lanes are bounded by.
    const memories: RetrievedMemory[] = Array.from({ length: 5 }, (_, index) => ({
      id: `mem-${index}`,
      content: '用户偏好简洁回复，不要长篇大论，直接给结论'.repeat(6),
      scope: 'user',
      kind: 'preference',
      score: 0.9 - index * 0.1,
      createdAt: index,
    }));
    const retriever = {
      retrieveGrouped: async () => memories,
      retrieve: async () => memories,
    } as unknown as MemoryRetriever;
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'notes-inject-shared-pool',
      agentId: 'agent-notes-pool',
      memoryRetriever: retriever,
      episodicContextProvider: () => [
        {
          createdAt: Date.UTC(2026, 9, 8),
          channel: 'feishu',
          sessionTitle: '脚本检查',
          role: 'user',
          excerpt: '上次那个批量替换脚本在 /srv/etl'.repeat(20),
        },
      ],
      notesContextProvider: () => offer('matched', 2),
    });

    const result = await transform([{ role: 'user', content: RECALL_QUERY }]);
    const injected = textBlocks(result[0]!.content)
      .filter((text) => /<(?:memory_context|recent_conversation|notes_context)>/.test(text))
      .join('\n');

    expect(injected).toContain('<notes_context>');
    expect(estimateTokensForText(injected)).toBeLessThanOrEqual(800);
  });

  it('records the injected note ids in the turn telemetry', async () => {
    const record = vi.spyOn(memoryObservability, 'record');
    try {
      const transform = createTransformContext({
        maxMessages: 5,
        sessionKey: 'notes-inject-telemetry',
        notesContextProvider: () => offer('matched', 1),
      });

      await transform([{ role: 'user', content: RECALL_QUERY }]);

      expect(record).toHaveBeenCalledTimes(1);
      const [event, details] = record.mock.calls[0]! as [string, Record<string, any>];
      expect(event).toBe('memory.injection');
      expect(details.noteIds).toEqual(['note-0']);
      expect(details.itemCounts.notes).toBe(1);
      expect(details.estimatedTokens.notes).toBeGreaterThan(0);
    } finally {
      record.mockRestore();
    }
  });
});

/**
 * The provider itself.
 *
 * The transform's trigger is a pattern match; what the *search* does with the
 * matched sentence is the other half. 「上次那个命令」 has no subject — 上次/那个
 * are deixis — so searching the sentence finds nothing, and searching it after
 * stripping finds the note. And a sentence with nothing left is not an error: it
 * is the "show me what I wrote down" case, which the block must label as such.
 */
describe('searchNotesContext', () => {
  function makeNote(overrides: Partial<Note> = {}): Note {
    return {
      id: 'note-1',
      title: '批量替换用 sed',
      summary: 'sed -i 批量替换 CSV 里的地址列。',
      body: 'BODY',
      fields: [],
      tags: [],
      status: 'active',
      statusReason: null,
      origin: 'agent',
      scope: 'user',
      scopeKey: '',
      sessionId: null,
      channel: 'webui',
      pinned: false,
      confidence: null,
      version: 1,
      captureId: null,
      viewCount: 0,
      lastViewedAt: null,
      reviewedAt: 1,
      createdAt: 1,
      updatedAt: 1,
      sources: [],
      related: [],
      ...overrides,
    };
  }

  function fakeNotes(notes: Note[]) {
    const list = vi.fn<NotesService['list']>((_query: NoteListQuery): NoteListResult => ({
      notes,
      total: notes.length,
      counts: { active: notes.length, draft: 0, archived: 0 },
      tags: [],
      channels: [],
      projects: [],
    }));
    return { service: { list } as unknown as NotesService, list };
  }

  const CONTEXT = { projectId: 'proj-1', channelKey: null, sessionId: 's-1' };

  it('searches the remainder, not the back-reference', () => {
    const notes = fakeNotes([makeNote()]);
    const result = searchNotesContext({
      notes: notes.service,
      query: '上次那个批量替换脚本用的什么命令？',
      context: CONTEXT,
    });

    expect(notes.list).toHaveBeenCalledTimes(1);
    const query = notes.list.mock.calls[0]![0];
    expect(query.status).toBe('active');
    expect(query.limit).toBe(2);
    expect(query.context).toEqual(CONTEXT);
    expect(query.q).toBe('批量替换脚本用的什么命令？');
    expect(query.q).not.toContain('上次');
    expect(result?.mode).toBe('matched');
    expect(result?.items).toEqual([
      { id: 'note-1', title: '批量替换用 sed', summary: 'sed -i 批量替换 CSV 里的地址列。' },
    ]);
  });

  it('falls back to the newest notes when nothing is left to search', () => {
    const notes = fakeNotes([makeNote(), makeNote({ id: 'note-2', title: '第二条' })]);
    const result = searchNotesContext({
      notes: notes.service,
      query: '上次那个呢？',
      context: CONTEXT,
    });

    // No `q`: browsing is the honest request when the turn carried no subject.
    expect(notes.list.mock.calls[0]![0]).not.toHaveProperty('q');
    expect(result?.mode).toBe('recent');
    expect(result?.items.map((item) => item.id)).toEqual(['note-1', 'note-2']);
  });

  it('offers nothing when the library has nothing to offer', () => {
    const notes = fakeNotes([]);
    expect(
      searchNotesContext({ notes: notes.service, query: '还记得吗', context: CONTEXT }),
    ).toBeUndefined();
  });

  it('never returns drafts: the status is the review gate, not an argument', () => {
    const notes = fakeNotes([makeNote()]);
    searchNotesContext({ notes: notes.service, query: '上次那个 sed 命令', context: CONTEXT });
    expect(notes.list.mock.calls[0]![0].status).toBe('active');
  });
});

/**
 * The same provider against the real notes service and a real FTS index.
 *
 * The stubs above pin the contract (status, limit, scope, and the query that
 * reaches `list`); what they cannot show is that the two modes are reachable
 * through the real FTS path — a fake service echoes whatever it is asked for,
 * including a query the index would refuse.
 */
describe('searchNotesContext over a real library', () => {
  function libraryWith(titles: string[]): { notes: NotesService; close: () => void } {
    const db = openDatabase(':memory:');
    const { service } = createTestService(db);
    for (const [index, title] of titles.entries()) {
      const created = service.createManual({
        title,
        summary: `关于${title}的一行摘要`,
        body: `正文 ${index}`,
        scope: 'user',
      });
      if (!created.ok) throw new Error(`fixture note refused: ${created.code}`);
    }
    return { notes: service, close: () => db.close() };
  }

  it('finds the note the stripped remainder describes', () => {
    const library = libraryWith(['批量替换用 sed', '部署脚本在 /srv/deploy']);
    try {
      const result = searchNotesContext({
        notes: library.notes,
        query: '上次那个批量替换用的什么？',
        context: { projectId: null, channelKey: null, sessionId: null },
      });

      expect(result?.mode).toBe('matched');
      expect(result?.items.map((item) => item.title)).toEqual(['批量替换用 sed']);
    } finally {
      library.close();
    }
  });

  it('browses the newest notes when the back-reference carried no subject', () => {
    const library = libraryWith(['批量替换用 sed', '部署脚本在 /srv/deploy']);
    try {
      const result = searchNotesContext({
        notes: library.notes,
        query: '上次那个呢？',
        context: { projectId: null, channelKey: null, sessionId: null },
      });

      expect(result?.mode).toBe('recent');
      expect(result?.items).toHaveLength(2);
    } finally {
      library.close();
    }
  });
});
