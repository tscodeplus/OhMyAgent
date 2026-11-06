import type { SessionListPage } from '../types/session';
import { readList, rememberList, forgetList, LIST_CACHE_TTL_MS } from './list-cache';

/**
 * The last page of a project's chats that was rendered, keyed by project.
 *
 * Two things read it. `POST /api/projects/ensure-default` ships page one with its
 * answer, and the sidebar renders that instead of asking again (behind a tunnel a
 * round trip costs about a second). And every drawer open on a phone mounts a
 * fresh copy of the tray — without this, each open showed a spinner while it
 * re-fetched a page it had just been looking at.
 *
 * A remount therefore paints what was on screen and refreshes behind it. The
 * shelf life only bounds how stale that first paint may be.
 */
const PRIMED_TTL_MS = 60_000;
/** How long a remembered page may seed a remount (refreshed in the background). */
export const SESSION_CACHE_TTL_MS = LIST_CACHE_TTL_MS;

const keyFor = (projectId: string): string => `sessions:${projectId}`;

/** Remember a page: the bootstrap answer, or the result of any successful fetch. */
export function primeSessionPage(projectId: string, page: SessionListPage | undefined): void {
  if (!projectId || !page || !Array.isArray(page.items)) return;
  rememberList(keyFor(projectId), page);
}

/**
 * The remembered page for a project plus how old it is, or `undefined` once it is
 * past `maxAgeMs`. The age is what lets a caller decide between "paint it and
 * refresh" and "do not bother, it is fresh".
 */
export function readSessionPage(
  projectId: string,
  maxAgeMs = PRIMED_TTL_MS,
): { page: SessionListPage; ageMs: number } | undefined {
  const read = readList<SessionListPage>(keyFor(projectId), maxAgeMs);
  return read ? { page: read.data, ageMs: read.ageMs } : undefined;
}

/** The remembered page for a project, or `undefined` once it has gone stale. */
export function peekSessionPage(
  projectId: string,
  maxAgeMs = PRIMED_TTL_MS,
): SessionListPage | undefined {
  return readSessionPage(projectId, maxAgeMs)?.page;
}

/** Forget a project's remembered page (its rows were deleted or replaced). */
export function clearSessionPage(projectId: string): void {
  forgetList(keyFor(projectId));
}
