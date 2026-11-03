/**
 * The notes service: the policy layer between the repository (which stores) and
 * the HTTP routes (which validate untrusted input).
 *
 * What lives here rather than in the repository:
 *
 * - **Authorship decides review** (§4.2-2). A manual note is `active` on arrival
 *   because the human typing it *is* the review; an agent draft is always
 *   `draft`, and the only way to `active` is `review()`.
 * - **Approval is a decision, not a side effect.** `update()` on a draft rewrites
 *   the draft's text and changes nothing else — editing must never approve, or
 *   the review gate becomes a formality with a save button.
 * - **Archive is soft and reversible** (§6): `archived` keeps the row, keeps the
 *   reason, and `restore()` returns it to `active` without re-running anything.
 *
 * The service reads its numeric knobs through `getConfig()` on every call: the
 * composer builds one instance for the process, and the WebUI settings must not
 * need a restart for a token budget change.
 */

import type { Logger } from 'pino';
import type { NotesRepository } from './repository.js';
import type { CapturePipeline } from './capture.js';
import { normalizeTags, normalizeTitle } from './canonical.js';
import {
  isNoteStatus,
  type Note,
  type NoteListQuery,
  type NoteListResult,
  type NoteStatus,
} from './types.js';
import type {
  CaptureRequest,
  CaptureResult,
  ManualNoteInput,
  ManualNoteResult,
  NotesRuntimeConfig,
  NotesService,
  NotesStats,
  PurgeOptions,
  PurgeResult,
  ReviewDecision,
  ReviewResult,
  UpdateResult,
} from './service-contract.js';

export interface NotesServiceDeps {
  repository: NotesRepository;
  capture: CapturePipeline;
  getConfig: () => NotesRuntimeConfig;
  logger: Logger;
}

export function createNotesService(deps: NotesServiceDeps): NotesService {
  const { repository, capture } = deps;

  return {
    capture(request: CaptureRequest): Promise<CaptureResult> {
      return capture.capture(request);
    },

    createManual(input: ManualNoteInput): ManualNoteResult {
      const tags = normalizeTags(input.tags);
      const created = repository.create({
        title: input.title.trim(),
        summary: (input.summary ?? '').trim(),
        body: input.body,
        fields: input.fields ?? [],
        tags,
        // A human wrote it, so it is already reviewed.
        status: 'active',
        origin: 'user',
        scope: input.scope ?? 'user',
        scopeKey: input.scopeKey ?? '',
        sessionId: input.sessionId ?? null,
        channel: input.channel ?? null,
        actor: input.actor ?? 'user',
      });
      if (!created.ok) return { ok: false, code: 'title_conflict', existingId: created.existingId };
      return { ok: true, note: created.note };
    },

    list(query: NoteListQuery): NoteListResult {
      return repository.list(query);
    },

    get(id: string): Note | undefined {
      return repository.get(id);
    },

    update(
      id: string,
      patch: {
        title?: string;
        summary?: string;
        body?: string;
        fields?: Note['fields'];
        tags?: string[];
        scope?: Note['scope'];
        scopeKey?: string;
        expectedVersion?: number;
      },
      actor = 'user',
    ): UpdateResult {
      const result = repository.update(id, { ...patch, actor });
      if (result.ok) return { ok: true, note: result.note };
      return result as UpdateResult;
    },

    review(id: string, decision: ReviewDecision): ReviewResult {
      const note = repository.get(id);
      if (!note) return { ok: false, code: 'not_found' };
      if (decision.decision === 'approve') {
        // Only a draft needs approval; approving an archived note would resurrect
        // it without the restore path that clears `status_reason`.
        if (note.status !== 'draft') return { ok: true, note };
        const updated = repository.setStatus(id, 'active', {
          actor: decision.actor ?? 'user',
          reviewedBy: decision.actor ?? 'user',
        });
        if (!updated) return { ok: false, code: 'not_found' };
        // Promotion can collide: an active note already owns this title in this
        // scope. Answering with the owner (422 at the route) lets the reader decide
        // — merge by hand, retitle, or discard — where a thrown constraint error
        // just left the draft unapprovable.
        if (!updated.ok)
          return { ok: false, code: 'title_conflict', existingId: updated.existingId };
        return { ok: true, note: updated.note };
      }
      // Only a draft has a verdict to give. A reject aimed at an `active` note — a
      // stale tab, a double click after an approval — is a no-op answered with the
      // note, because erasing a published note through the review route is the one
      // outcome nobody can undo.
      if (note.status !== 'draft') return { ok: true, note };
      // A verdict is final for a draft, and it is the *content* that goes: the body,
      // its evidence, its relations and its index row are erased, while the `reject`
      // event stays behind so `approvalRate` still counts what the reviewer said.
      // "Delete" and "reject" are one operation because there is nowhere left for a
      // refused draft to wait — `archived` holds notes the user put away, and a
      // rejected draft sitting there was one `恢复` click from being published
      // unreviewed.
      const rejected = repository.rejectDraft(id, decision.reason ?? 'other', decision.actor);
      if (!rejected.ok) return { ok: false, code: 'not_found' };
      deps.logger.info(
        { noteId: id, code: decision.reason ?? 'other', actor: decision.actor ?? 'user' },
        'notes.reject',
      );
      return { ok: true, deleted: true, id };
    },

    pin(id: string, pinned: boolean): UpdateResult {
      const updated = repository.setPinned(id, pinned);
      return updated ? { ok: true, note: updated } : { ok: false, code: 'not_found' };
    },

    archive(id: string, reason = 'user'): UpdateResult {
      const note = repository.get(id);
      if (!note) return { ok: false, code: 'not_found' };
      // Only a note can be archived. Putting a *draft* away would mean an unreviewed
      // draft living in `archived` with a `user` reason — exactly the row whose
      // `恢复` publishes it without review — so archiving a draft is a discard, and a
      // discard erases. The route keeps `DELETE /api/notes/:id` for both because from
      // the caller's side it is one sentence: "I do not want this in my list".
      if (note.status === 'draft') {
        const rejected = repository.rejectDraft(id, 'other', 'user');
        return rejected.ok ? { ok: true } : { ok: false, code: 'not_found' };
      }
      const updated = repository.setStatus(id, 'archived', { reason, actor: 'user' });
      if (!updated) return { ok: false, code: 'not_found' };
      return updated.ok
        ? { ok: true, note: updated.note }
        : { ok: false, code: 'title_conflict', existingId: updated.existingId };
    },

    restore(id: string): UpdateResult {
      const note = repository.get(id);
      if (!note) return { ok: false, code: 'not_found' };
      // Drafts never expire any more, so `expired` only survives in databases written
      // before that policy was removed. Restoring one of those to `active` would
      // publish a draft nobody ever reviewed; the queue is where it belongs.
      const target: NoteStatus = note.statusReason === 'expired' ? 'draft' : 'active';
      const updated = repository.setStatus(id, target, { actor: 'user' });
      if (!updated) return { ok: false, code: 'not_found' };
      // Restoring a note whose title was taken while it was archived is the other
      // way to reach the unique index; same answer as approval.
      return updated.ok
        ? { ok: true, note: updated.note }
        : { ok: false, code: 'title_conflict', existingId: updated.existingId };
    },

    recordView(id: string): void {
      // A view is not worth a write if the note does not exist; `recordView` on a
      // missing row would still append an event.
      if (!repository.get(id)) return;
      repository.recordView(id);
    },

    purge(id: string, options: PurgeOptions): PurgeResult {
      const note = repository.get(id);
      if (!note) return { ok: false, code: 'not_found' };
      // The stored comparison key, not the stored string: retyping `termux换源` for a
      // note titled `Termux 换源` has to work, because that is the same subject by the
      // only rule the library has (the one the unique index enforces). Anything
      // stricter would make the guard a test of punctuation memory.
      if (normalizeTitle(options.title) !== normalizeTitle(note.title)) {
        return { ok: false, code: 'title_mismatch' };
      }
      const purged = repository.purge(id);
      if (!purged.ok) return purged;
      // A purge deliberately leaves no audit trail — erasing something means it must
      // read as if it never existed, and `note_events` going with the note is part of
      // that. This line is therefore the *only* record that it happened: whoever has
      // to answer "what happened to that note" has this and nothing else.
      deps.logger.info({ noteId: id, actor: options.actor ?? 'user' }, 'notes.purge');
      return { ok: true };
    },

    stats(): NotesStats {
      // Only the tallies: this used to call `list({ limit: 1 })` and drop the note,
      // so answering "how many drafts" opened a whole list page (facets, sources,
      // relations and their probes) to read three numbers.
      const counts = repository.counts();
      // Deliberately not `active / (active + archived)` any more: `archived` holds the
      // notes the user put away themselves, so the old proxy answered "how much of the
      // library is archived" while its name promised a review verdict. The verdicts are
      // the ones `review()` recorded — `approved` and `rejected` are both only ever
      // written there, and a rejected draft keeps its event after its body is erased.
      const tally = repository.reviewTally();
      const reviewed = tally.approved + tally.rejected;
      return {
        byStatus: counts,
        approvalRate: reviewed > 0 ? Math.round((tally.approved / reviewed) * 100) / 100 : 0,
      };
    },
  };
}

/** Statuses the HTTP layer may ask for, so a route cannot invent a new one. */
export function isListableStatus(value: unknown): value is NoteStatus {
  return isNoteStatus(value);
}
