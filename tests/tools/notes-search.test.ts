/**
 * `notes_search` — the notes layer's read path back to the model
 * (MyDocs/NOTES_LAYER_REVIEW_2026-11-02.md §4 U1).
 *
 * Three properties are worth pinning, because each one is a way the tool could
 * quietly become wrong:
 *
 *   1. the status: only `active` notes are asked for, so the model can never
 *      read its own unapproved draft (the review gate is the whole point of the
 *      layer);
 *   2. the scope context: derived from the turn, never from the arguments, or a
 *      prompt could ask for another project's notes;
 *   3. the payload: id / title / summary / fields / tags / updatedAt, and never
 *      the body — a grep-shaped answer must not cost twenty note bodies.
 *
 * The service is faked here on purpose: this is a test of the tool's contract,
 * not of SQLite ranking (that lives in tests/notes/).
 */

import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  createNotesSearchToolDefinition,
  notesSearchToolCapability,
} from '../../src/tools/builtins/notes/notes-search-definition.js';
import {
  MAX_NOTES_SEARCH_LIMIT,
  notesScopeContext,
  runNotesSearch,
} from '../../src/tools/builtins/notes/notes-search-tool.js';
import { createNotesToolDefinitions } from '../../src/app/composers/tool-services.js';
import { createToolContext } from '../../src/tools/platform/tool-context.js';
import type { ToolExecutionResult } from '../../src/tools/platform/tool-result.js';
import type { Note, NoteListQuery, NoteListResult } from '../../src/notes/types.js';
import type { NotesService } from '../../src/notes/service-contract.js';
import type { AppServices } from '../../src/app/types.js';

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 'note-1',
    title: 'vitest 只跑改过的文件',
    summary: 'Run only the affected test files, then the full suite once.',
    body: 'SECRET BODY — must never be rendered into a tool result',
    fields: [{ key: 'command', value: 'npx vitest run tests/notes', mono: true }],
    tags: ['command', 'pitfall'],
    status: 'active',
    statusReason: null,
    origin: 'agent',
    scope: 'user',
    scopeKey: '',
    sessionId: null,
    channel: 'webui',
    pinned: false,
    confidence: 0.8,
    version: 1,
    captureId: null,
    viewCount: 0,
    lastViewedAt: null,
    reviewedAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_731_000_000_000,
    sources: [],
    related: [],
    ...overrides,
  };
}

interface FakeNotes {
  service: NotesService;
  list: Mock<NotesService['list']>;
}

/**
 * Only `list` is reachable from the tool; every other method throws, so a test
 * that accidentally reaches one fails loudly instead of reading a plausible
 * empty value.
 */
function fakeNotes(notes: Note[] = [makeNote()]): FakeNotes {
  const list = vi.fn<NotesService['list']>((_query: NoteListQuery): NoteListResult => ({
    notes,
    total: notes.length,
    counts: { active: notes.length, draft: 0, archived: 0 },
    tags: [],
    channels: [],
    projects: [],
  }));
  const unsupported = (name: string) => () => {
    throw new Error(`${name} is not reachable from notes_search`);
  };
  const service = {
    list,
    capture: unsupported('capture'),
    createManual: unsupported('createManual'),
    get: unsupported('get'),
    update: unsupported('update'),
    review: unsupported('review'),
    pin: unsupported('pin'),
    archive: unsupported('archive'),
    restore: unsupported('restore'),
    recordView: unsupported('recordView'),
    stats: unsupported('stats'),
  } as unknown as NotesService;

  return { service, list };
}

function textOf(result: ToolExecutionResult): string {
  return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/** A minimal pino-shaped sink; the tool only ever calls `debug`. */
function silentLogger(): AppServices['logger'] {
  return { debug: () => {}, warn: () => {} } as unknown as AppServices['logger'];
}

describe('notes_search arguments', () => {
  it('asks only for approved notes, and defaults to five of them', () => {
    const notes = fakeNotes();
    runNotesSearch({ query: 'vitest' }, { notes: notes.service, context: null });

    expect(notes.list).toHaveBeenCalledTimes(1);
    expect(notes.list.mock.calls[0][0]).toEqual({
      status: 'active',
      q: 'vitest',
      limit: 5,
      context: null,
    });
  });

  it('honours an explicit limit', () => {
    const notes = fakeNotes();
    runNotesSearch({ query: 'vitest', limit: 12 }, { notes: notes.service, context: null });
    expect(notes.list.mock.calls[0][0].limit).toBe(12);
  });

  it('refuses a limit above the cap instead of silently clamping it', () => {
    // Silent clamping is the worse failure: the model believes it read the whole
    // page and stops asking.
    const notes = fakeNotes();
    const result = runNotesSearch(
      { query: 'vitest', limit: MAX_NOTES_SEARCH_LIMIT + 1 },
      { notes: notes.service, context: null },
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`less than or equal to ${MAX_NOTES_SEARCH_LIMIT}`);
    expect(notes.list).not.toHaveBeenCalled();
  });

  it('refuses a blank query rather than browsing the library', () => {
    // `list()` treats an empty `q` as "browse", which would answer a search with
    // five arbitrary notes — a silent wrong answer, not an empty one.
    const notes = fakeNotes();
    const result = runNotesSearch({ query: '   ' }, { notes: notes.service, context: null });
    expect(result.isError).toBe(true);
    expect(notes.list).not.toHaveBeenCalled();
  });
});

describe('notes_search scope context', () => {
  it('derives the channel key exactly as a note is written', () => {
    // `defaultScope()` writes `<channel>:<chatId>` for a group chat's note; any
    // other spelling would silently match nothing.
    expect(
      notesScopeContext({
        cwd: '/',
        services: {} as AppServices,
        policyScope: {} as never,
        channel: 'feishu',
        chatId: 'oc_abc123',
        sessionId: 's-1',
      }),
    ).toEqual({ projectId: null, channelKey: 'feishu:oc_abc123', sessionId: 's-1' });
  });

  it('means "no restriction" when the turn knows nothing about where it is', () => {
    expect(
      notesScopeContext({ cwd: '/', services: {} as AppServices, policyScope: {} as never }),
    ).toBeNull();
  });

  it('reaches the service through the definition, from the tool context', async () => {
    const notes = fakeNotes();
    const definition = createNotesSearchToolDefinition({ notes: notes.service });
    const ctx = createToolContext({} as AppServices, {
      sessionId: 's-1',
      projectId: 'proj-9',
      channel: 'telegram',
      chatId: '-100200',
    });

    await definition.execute({ query: 'pnpm' }, ctx);

    expect(notes.list.mock.calls[0][0].context).toEqual({
      projectId: 'proj-9',
      channelKey: 'telegram:-100200',
      sessionId: 's-1',
    });
  });
});

describe('notes_search result', () => {
  it('renders the reviewed fields and never the body', () => {
    const result = runNotesSearch(
      { query: 'vitest' },
      { notes: fakeNotes().service, context: null },
    );
    const text = textOf(result);

    expect(text).toContain('vitest 只跑改过的文件');
    expect(text).toContain('Run only the affected test files');
    expect(text).toContain('command=npx vitest run tests/notes');
    expect(text).toContain('tags command, pitfall');
    expect(text).toContain('id note-1');
    expect(text).toContain('2024-11-07 17:20Z');
    expect(text).not.toContain('SECRET BODY');
  });

  it('carries the same six fields in metadata as in the text', () => {
    const result = runNotesSearch(
      { query: 'vitest' },
      { notes: fakeNotes().service, context: null },
    );
    expect(result.metadata?.hits).toEqual([
      {
        id: 'note-1',
        title: 'vitest 只跑改过的文件',
        summary: 'Run only the affected test files, then the full suite once.',
        fields: [{ key: 'command', value: 'npx vitest run tests/notes', mono: true }],
        tags: ['command', 'pitfall'],
        updatedAt: 1_731_000_000_000,
      },
    ]);
  });

  it('names the review gate when nothing matches, instead of a bare "no results"', () => {
    const result = runNotesSearch(
      { query: 'nothing' },
      { notes: fakeNotes([]).service, context: null },
    );
    expect(textOf(result)).toContain('Drafts and archived notes are not searchable');
  });

  it('turns a failing service into an error result, not a failed turn', () => {
    const notes = fakeNotes();
    notes.list.mockImplementation(() => {
      throw new Error('database is locked');
    });

    const result = runNotesSearch({ query: 'vitest' }, { notes: notes.service, context: null });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('database is locked');
  });
});

describe('notes_search registration gate', () => {
  it('does not register while the notes layer is off', () => {
    // `notesServices.notesService` is absent exactly when `notes.enabled` is
    // false, so this is the "layer off ⇒ tool invisible" guard.
    expect(createNotesToolDefinitions({ logger: silentLogger() })).toEqual([]);
  });

  it('registers a deferrable read-only tool when the layer is on', () => {
    const definitions = createNotesToolDefinitions({
      notes: fakeNotes().service,
      logger: silentLogger(),
    });

    expect(definitions.map((definition) => definition.name)).toEqual(['notes_search']);
    expect(definitions[0].deferrable).toBe(true);
    expect(definitions[0].capability).toEqual(notesSearchToolCapability);
    expect(definitions[0].capability.readOnly).toBe(true);
  });
});
