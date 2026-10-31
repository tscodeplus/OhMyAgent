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
import { normalizeTags } from './canonical.js';
import {
  isNoteKind,
  isNoteStatus,
  type Note,
  type NoteKind,
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
  ReviewDecision,
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

    prefill(sessionId: string): string | null {
      return capture.prefillText(sessionId);
    },

    createManual(input: ManualNoteInput): ManualNoteResult {
      const tags = normalizeTags(input.tags);
      const created = repository.create({
        kind: isNoteKind(input.kind) ? input.kind : 'other',
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
        kind?: NoteKind;
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

    review(id: string, decision: ReviewDecision): UpdateResult {
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
        return updated ? { ok: true, note: updated } : { ok: false, code: 'not_found' };
      }
      // Two different facts: the row leaves the library as `rejected`, and the
      // code (duplicate / recap / thin …) goes into the log so the tally is
      // actionable. Storing the code in `status_reason` would make the column a
      // mix of lifecycle and diagnosis.
      const updated = repository.setStatus(id, 'archived', {
        reason: 'rejected',
        detail: decision.reason ?? 'other',
        actor: decision.actor ?? 'user',
      });
      return updated ? { ok: true, note: updated } : { ok: false, code: 'not_found' };
    },

    pin(id: string, pinned: boolean): UpdateResult {
      const updated = repository.setPinned(id, pinned);
      return updated ? { ok: true, note: updated } : { ok: false, code: 'not_found' };
    },

    archive(id: string, reason = 'user'): UpdateResult {
      const updated = repository.setStatus(id, 'archived', { reason, actor: 'user' });
      return updated ? { ok: true, note: updated } : { ok: false, code: 'not_found' };
    },

    restore(id: string): UpdateResult {
      const note = repository.get(id);
      if (!note) return { ok: false, code: 'not_found' };
      const updated = repository.setStatus(id, 'active', { actor: 'user' });
      return updated ? { ok: true, note: updated } : { ok: false, code: 'not_found' };
    },

    recordView(id: string): void {
      // A view is not worth a write if the note does not exist; `recordView` on a
      // missing row would still append an event.
      if (!repository.get(id)) return;
      repository.recordView(id);
    },

    stats(): NotesStats {
      const counts = repository.list({ status: 'active', limit: 1 }).counts;
      const byKind: Record<string, number> = {};
      const rows = repository.summarizeKinds();
      for (const row of rows) byKind[row.kind] = row.count;
      const config = deps.getConfig();
      const due =
        config.ttlDays > 0
          ? repository.countDraftsOlderThan(Date.now() - (config.ttlDays - 1) * 24 * 3600_000)
          : 0;
      const archived = counts.archived ?? 0;
      return {
        byStatus: counts,
        byKind,
        draftsDue: due,
        // Approved drafts / everything that ever entered review is the honest
        // denominator; the repository does not keep that, so this is a proxy.
        approvalRate:
          counts.active > 0
            ? Math.round((counts.active / (counts.active + archived)) * 100) / 100
            : 0,
      };
    },
  };
}

/** Statuses the HTTP layer may ask for, so a route cannot invent a new one. */
export function isListableStatus(value: unknown): value is NoteStatus {
  return isNoteStatus(value);
}
