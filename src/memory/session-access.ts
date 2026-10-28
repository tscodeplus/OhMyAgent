/**
 * Session access policy — the session/message dimension `MemoryAccessPolicy`
 * does not have.
 *
 * `MemoryAccessPolicy` (`memory-access-policy.ts`) answers "may this *memory*
 * row be shown": its fields are `scope`/`scopeKey`/`agentId`/`visibility`, and
 * it takes a `Memory`. Conversation search needs the same question asked about
 * a *session*, which carries `project_id`, `channel` and `chat_id` instead, so
 * the two policies are separate rather than one being bent to fit both.
 *
 * The one rule this module exists to protect: **defaults must not filter.**
 * `channels: undefined` means "every channel", including the `unknown` bucket,
 * and `projectId: undefined` means "every project, plus the IM inbox". A
 * default written as an `INBOX_CHANNELS` whitelist would silently exclude both
 * `unknown` and every channel added later — in the live database the single
 * `unknown` session is the seed session `shadow-seed-1007`, where `unknown` is
 * the *correct* classification (`inferChannel` returns it deliberately) and
 * must only affect how a hit is labelled, never whether it is findable.
 */

import { inferChannel } from './session-channel.js';

/** The `sessions` columns this layer reads. */
export interface SessionRow {
  id: string;
  project_id?: string | null;
  channel?: string | null;
  chat_id?: string | null;
}

export interface SessionAccessPolicy {
  /**
   * Restrict to one project.
   *   `undefined` — no project filter (the default)
   *   a project id — only that project's sessions
   *   `null`       — only sessions with no project, i.e. the IM inbox
   */
  projectId?: string | null;
  /**
   * Restrict to these channels (`'feishu'`, `'unknown'`, …).
   *   `undefined` — every channel, `unknown` included (the default)
   *   `[]`        — nothing is visible; an explicit empty list means empty
   */
  channels?: readonly string[];
  /**
   * Whether sessions without a project (the IM inbox) are visible at all.
   * Default `true`: the inbox is read-only by design, which makes reading
   * across channels safe.
   */
  includeInbox?: boolean;
}

/**
 * The session's channel, recorded value first.
 *
 * Same precedence `graph-routes.ts` uses for `/api/sessions/:id/context`
 * (`COALESCE(channel, inferChannel(id, chat_id))`): rows written before v9 have
 * no `channel` column value, and `inferChannel` derives it from the identifiers
 * those rows do carry.
 */
export function resolveSessionChannel(session: SessionRow): string {
  return session.channel ?? inferChannel(session.id, session.chat_id ?? null);
}

/**
 * Whether `session` is visible under `policy`. Unset fields never filter.
 *
 * The two project dimensions are deliberately not the same question: a
 * project-less (IM) session is decided by `includeInbox` alone, so that
 * narrowing to one project still reaches the inbox. Folding them together would
 * make `includeInbox` dead the moment a caller sets `projectId`.
 */
export function sessionVisible(session: SessionRow, policy: SessionAccessPolicy = {}): boolean {
  const projectId = session.project_id ?? null;

  if (projectId === null) {
    if (policy.includeInbox === false) return false;
    // `projectId: null` means "the IM inbox only"; a concrete project id is
    // about project sessions and leaves the inbox alone.
    if (
      policy.channels !== undefined &&
      !policy.channels.includes(resolveSessionChannel(session))
    ) {
      return false;
    }
    return true;
  }

  if (policy.projectId !== undefined && projectId !== policy.projectId) return false;
  if (policy.channels !== undefined && !policy.channels.includes(resolveSessionChannel(session))) {
    return false;
  }

  return true;
}
