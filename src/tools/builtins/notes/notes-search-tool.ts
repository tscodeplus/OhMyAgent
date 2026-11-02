/**
 * `notes_search` — the notes layer's read path back to the model
 * (MyDocs/NOTES_LAYER_REVIEW_2026-11-02.md §4 U1).
 *
 * The gap this closes: a note could be produced (capture → distill → human
 * review) and read back only by a human scrolling the WebUI. The distiller is
 * told to "produce only knowledge that will be needed again", and "again" had
 * no route. This is `session_search`'s shape one table over: the same
 * `{query, limit}` arguments, the same deferrable definition, the same
 * "ids and a preview, not the whole row" result.
 *
 * ## `status: 'active'` is not an argument
 *
 * A draft has not been through review, so it is not knowledge yet — letting the
 * model read its own unapproved note would make the human gate decorative.
 * `archived` left the library. So the status is fixed here instead of exposed:
 * the only thing the caller chooses is what to look for and how many.
 *
 * ## Scope comes from the turn, never from the arguments
 *
 * `NotesService.list()` applies the same read rule the WebUI does
 * (`readableScopeSql`): the person's own notes plus the project / chat / session
 * this turn is in. Building that context from the tool's execution context
 * (below) is what stops a prompt from asking for another project's notes.
 *
 * ## What comes back, and what does not
 *
 * id, title, summary, fields, tags, updatedAt — enough to recognise the note and
 * to read the copy-pasteable values out of `fields`. `body` is not returned:
 * twenty bodies would be a prompt cost paid for one answer, and the summary plus
 * fields are what the reviewer approved as the reusable part.
 */

import { z } from 'zod';
import type { Logger } from 'pino';
import { zodToTypeBox } from '../../tool-adapter.js';
import { errorResult, textResult } from '../../platform/tool-result.js';
import type { ToolExecutionResult } from '../../platform/tool-result.js';
import type { ToolExecutionContext } from '../../platform/tool-context.js';
import { channelScopeKey } from '../../../notes/scope.js';
import type { Note, NoteScopeContext } from '../../../notes/types.js';
import type { NotesService } from '../../../notes/service-contract.js';

export const NOTES_SEARCH_TOOL_NAME = 'notes_search';
export const NOTES_SEARCH_TOOL_LABEL = 'Notes Search';

/** Five notes is a page a model reads; twenty is the cap a request may ask for. */
export const DEFAULT_NOTES_SEARCH_LIMIT = 5;
export const MAX_NOTES_SEARCH_LIMIT = 20;

export const notesSearchParams = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .describe(
      'What to look for in the notes library. Keyword search (BM25); Chinese and English both work.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_NOTES_SEARCH_LIMIT)
    .optional()
    .describe(`Maximum notes to return (default ${DEFAULT_NOTES_SEARCH_LIMIT}).`),
});

export type NotesSearchArgs = z.infer<typeof notesSearchParams>;

export const NOTES_SEARCH_PARAMETERS_SCHEMA = zodToTypeBox(notesSearchParams);

export const NOTES_SEARCH_DESCRIPTION =
  'Search the notes library: reusable knowledge a human reviewed and approved — commands that ' +
  'worked, pitfalls, workflows, settled decisions. Use it when the question is "did I write this ' +
  'down / did we settle this", not when it is "when did we talk about this": for the original ' +
  'conversation text use session_search. Returns id, title, summary, fields and tags of approved ' +
  'notes only; drafts you produced are waiting for review and are not visible here.';

/** The fields of a note this tool exposes; `body` is deliberately absent. */
export interface NotesSearchHit {
  id: string;
  title: string;
  summary: string;
  fields: Note['fields'];
  tags: string[];
  updatedAt: number;
}

export interface NotesSearchToolOptions {
  notes: NotesService;
  /**
   * The read-rule context of this turn. `null` means "no restriction" — the same
   * meaning it has for the WebUI console (`readableScopeSql`).
   */
  context: NoteScopeContext | null;
  logger?: Pick<Logger, 'debug' | 'warn'>;
}

/**
 * The scope context a tool invocation carries (plan §4.2-5).
 *
 * `channelKey` is `<channel>:<chatId>`, the exact key `defaultScope()` writes for
 * a group chat's note — a key derived any other way would silently match
 * nothing. A WebUI project chat synthesises `chatId` as `webui:<projectId>`, so
 * its key matches no stored note; that is harmless (a key that matches nothing
 * filters nothing away) and cheaper than teaching this function a channel
 * vocabulary the notes layer does not own.
 */
export function notesScopeContext(ctx: ToolExecutionContext): NoteScopeContext | null {
  const projectId = ctx.projectId ?? null;
  const channelKey = ctx.channel && ctx.chatId ? channelScopeKey(ctx.channel, ctx.chatId) : null;
  const sessionId = ctx.sessionId ?? null;
  if (!projectId && !channelKey && !sessionId) return null;
  return { projectId, channelKey, sessionId };
}

/** Run the search and render it for the model. */
export function runNotesSearch(
  args: NotesSearchArgs,
  options: NotesSearchToolOptions,
): ToolExecutionResult {
  const parsed = notesSearchParams.safeParse(args);
  if (!parsed.success) {
    return errorResult(
      `Invalid notes_search arguments: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'args'} ${issue.message}`)
        .join('; ')}`,
    );
  }
  const input = parsed.data;
  const limit = input.limit ?? DEFAULT_NOTES_SEARCH_LIMIT;

  let notes: Note[];
  try {
    // `status` and `context` are not caller-chosen: one is the review gate, the
    // other is the turn's own scope. Only `q` and `limit` come from the model.
    notes = options.notes.list({
      status: 'active',
      q: input.query,
      limit,
      context: options.context,
    }).notes;
  } catch (err) {
    return errorResult(`notes_search failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  options.logger?.debug({ query: input.query, hitCount: notes.length, limit }, 'notes_search');

  const hits: NotesSearchHit[] = notes.map((note) => ({
    id: note.id,
    title: note.title,
    summary: note.summary,
    fields: note.fields,
    tags: note.tags,
    updatedAt: note.updatedAt,
  }));

  const metadata = { query: input.query, hits };

  if (hits.length === 0) {
    return textResult(
      `No approved note matched "${input.query}". (Drafts and archived notes are not searchable.)`,
      metadata,
    );
  }

  const sections = [
    `Found ${hits.length} approved note(s) for "${input.query}":`,
    notes.map((note, index) => formatNoteHit(note, index)).join('\n\n'),
  ];

  return textResult(sections.join('\n\n'), metadata);
}

function formatNoteHit(note: Note, index: number): string {
  const lines = [`${index + 1}. ${note.title}`];
  if (note.summary) lines.push(`   ${note.summary}`);
  if (note.fields.length > 0) {
    lines.push(
      `   fields: ${note.fields.map((field) => `${field.key}=${field.value}`).join(' | ')}`,
    );
  }
  const meta = [`id ${note.id}`, describeScope(note), `updated ${formatTime(note.updatedAt)}`];
  if (note.tags.length > 0) meta.push(`tags ${note.tags.join(', ')}`);
  lines.push(`   (${meta.join(' · ')})`);
  return lines.join('\n');
}

/** Where the note lives, in the words a person would use for it. */
function describeScope(note: Note): string {
  switch (note.scope) {
    case 'user':
      return 'personal';
    case 'project':
      return `project ${note.projectName ?? note.scopeKey}`;
    case 'channel':
      return `channel ${note.scopeKey}`;
    case 'session':
      return `session ${note.scopeKey}`;
  }
}

/** `2026-11-02 14:03Z`; the epoch-ms number is formatted, never re-parsed as text. */
function formatTime(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return 'unknown time';
  return `${new Date(epochMs).toISOString().slice(0, 16).replace('T', ' ')}Z`;
}
