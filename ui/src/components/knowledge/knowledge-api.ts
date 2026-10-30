/**
 * Fetch wrappers for the knowledge-page API (`src/app/webui/knowledge-routes.ts`).
 *
 * `apiRequest` (utils/api.ts) collapses an error response to `{status,message}`,
 * which is not enough here: the 409 of `PUT /api/knowledge/page/:id` carries
 * `currentVersion` and `currentContent`, and those two fields are the whole
 * reason the editor can show a conflict instead of silently overwriting a newer
 * page. So this module issues its own requests and keeps the parsed body on the
 * error. Everything else (`getToken`, the 10s timeout, JSON headers) follows
 * `apiRequest` exactly, so auth and timeouts behave like the rest of the app.
 */

import { getToken } from '../../utils/api';
import type {
  KnowledgePageDetailPayload,
  KnowledgePageListPayload,
  KnowledgePagePatch,
  KnowledgePageStatus,
  KnowledgePendingPayload,
  KnowledgeSearchPayload,
  KnowledgeStatsPayload,
  KnowledgeStatusChangePayload,
  KnowledgeWriteAccepted,
  PageType,
  RejectionReason,
} from './types';

const DEFAULT_TIMEOUT_MS = 10_000;

/** Error body as the routes send it; every field beyond `error` is endpoint-specific. */
export interface KnowledgeErrorBody {
  error?: string;
  code?: string;
  message?: string;
  /** 409 from PUT: the version the caller collided with. */
  currentVersion?: number;
  /** 409 from PUT: that version's body, so the editor can show what it missed. */
  currentContent?: string;
  /** 400 `unknown_sources`: citations that did not resolve. */
  missing?: Array<{ kind: string; id: string }>;
  /** 400 `invalid_page_type`. */
  allowed?: string[];
  /** 400 `admission_rejected`. */
  reason?: string;
  detail?: string;
}

/** A non-2xx answer, with the body preserved (see the module comment). */
export class KnowledgeApiError extends Error {
  readonly status: number;
  readonly body: KnowledgeErrorBody;

  constructor(status: number, message: string, body: KnowledgeErrorBody) {
    super(message);
    this.name = 'KnowledgeApiError';
    this.status = status;
    this.body = body;
  }

  /** `expectedVersion` did not match — the caller must re-read before writing. */
  get isVersionConflict(): boolean {
    return this.status === 409 && this.body.currentVersion !== undefined;
  }
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...((init.headers as Record<string, string>) || {}) };
  if (init.body) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token && !headers['Authorization']) headers['Authorization'] = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(path, { ...init, headers, signal: controller.signal });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as KnowledgeErrorBody;
      throw new KnowledgeApiError(
        response.status,
        body.message || body.error || response.statusText,
        body,
      );
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Browse pages, newest-updated first. `status` must be `active` or `archived`. */
export function listKnowledgePages(params: {
  status: Exclude<KnowledgePageStatus, 'pending'>;
  pageType?: PageType;
  limit: number;
  offset: number;
}): Promise<KnowledgePageListPayload> {
  return request<KnowledgePageListPayload>(
    `/api/knowledge/pages${buildQuery({
      status: params.status,
      pageType: params.pageType,
      limit: params.limit,
      offset: params.offset,
    })}`,
  );
}

/** Full-text search over active pages; `q` is required by the route. */
export function searchKnowledgePages(params: {
  q: string;
  pageType?: PageType;
  limit: number;
}): Promise<KnowledgeSearchPayload> {
  return request<KnowledgeSearchPayload>(
    `/api/knowledge/search${buildQuery({
      q: params.q,
      pageType: params.pageType,
      limit: params.limit,
    })}`,
  );
}

/** One page with its sources and outgoing links. 404 for a pending or archived page. */
export function fetchKnowledgePage(id: string): Promise<KnowledgePageDetailPayload> {
  return request<KnowledgePageDetailPayload>(`/api/knowledge/page/${encodeURIComponent(id)}`);
}

/** The shadow-mode review queue — the only listing that returns pending bodies. */
export function fetchPendingKnowledgePages(limit: number): Promise<KnowledgePendingPayload> {
  return request<KnowledgePendingPayload>(`/api/knowledge/pending${buildQuery({ limit })}`);
}

/**
 * Update a page. `expectedVersion` must be the version the editor loaded; a
 * mismatch rejects with a `KnowledgeApiError` whose `body` carries the current
 * version and content, and nothing is written.
 */
export function updateKnowledgePage(
  id: string,
  patch: KnowledgePagePatch,
): Promise<KnowledgeWriteAccepted> {
  return request<KnowledgeWriteAccepted>(`/api/knowledge/page/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}

/** `pending` → `active`: the page becomes visible to search and to the agent. */
export function approveKnowledgePage(id: string): Promise<KnowledgeStatusChangePayload> {
  return request<KnowledgeStatusChangePayload>(
    `/api/knowledge/page/${encodeURIComponent(id)}/approve`,
    { method: 'POST' },
  );
}

/**
 * Reject a draft: kept for history, no longer offered, and *why* is recorded.
 *
 * The reason is a `REJECTION_REASONS` code so the server can tally it; `note` is
 * the reviewer's own sentence and lands in a separate column, which is why the code
 * stays groupable. Both are optional — an unreasoned archive still works, it just
 * contributes nothing to the tally.
 */
export function archiveKnowledgePage(
  id: string,
  options: { reason?: RejectionReason; note?: string } = {},
): Promise<KnowledgeStatusChangePayload> {
  const body: { reason?: RejectionReason; note?: string } = {};
  if (options.reason !== undefined) body.reason = options.reason;
  const note = options.note?.trim();
  if (note) body.note = note;
  return request<KnowledgeStatusChangePayload>(
    `/api/knowledge/page/${encodeURIComponent(id)}/archive`,
    { method: 'POST', body: JSON.stringify(body) },
  );
}

/** Counts plus the FTS parity report (`fts: null` = not checked, not "fine"). */
export function fetchKnowledgeStats(): Promise<KnowledgeStatsPayload> {
  return request<KnowledgeStatsPayload>('/api/knowledge/stats');
}
