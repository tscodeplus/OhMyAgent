/**
 * Session message projection — shared by the project-scoped session route and
 * the IM inbox route.
 *
 * Lifted verbatim out of the `registerSessionRoutes` detail handler so the two
 * entry points cannot drift: the block-order segment reconstruction, the
 * three media sources and the per-message footer snapshot are the parts most
 * likely to be quietly improved in one place and forgotten in the other.
 */

import type Database from 'better-sqlite3';
import type { FooterConfig } from '../types.js';
import { stripXmlTag } from '../../shared/text-extract.js';
import { refreshDownloadUrl } from '../../shared/download-token.js';
import { CHAT_MEDIA_TOOL_NAMES, isChatMediaUrl } from '../../shared/chat-media.js';

/** Refresh /dl/ tokens in place; see refreshPersistedDownloadUrls below. */
export function refreshPersistedDownloadUrls(
  images: Array<{ url: string }>,
  files: Array<{ path: string }>,
): void {
  for (const img of images) {
    if (img.url.startsWith('/dl/')) {
      const refreshed = refreshDownloadUrl(img.url);
      if (refreshed) img.url = refreshed;
    }
  }
  for (const f of files) {
    if (f.path.startsWith('/dl/')) {
      const refreshed = refreshDownloadUrl(f.path);
      if (refreshed) f.path = refreshed;
    }
  }
}

export interface LoadSessionMessagesOptions {
  /** Page size, already clamped by the caller. */
  limit: number;
  /** Exclusive ms timestamp cursor — only messages strictly older than this. */
  before?: number;
  /**
   * Tie-breaker for `before`: the id of the cursor message.
   *
   * `created_at` is not unique — a turn can persist several rows (assistant +
   * tool results) inside one millisecond — so a cursor that compares the
   * timestamp alone loses every sibling once the page boundary falls inside such
   * a group. `(created_at, id)` is unique. Omitted means the old single-field
   * comparison, kept for callers that do not track ids.
   */
  beforeId?: string;
  getFooterConfig?: () => FooterConfig;
}

/**
 * "Older than the cursor" under `ORDER BY created_at DESC, id DESC`.
 *
 * Binds both values as TEXT: `created_at` is a TEXT column of epoch-ms digit
 * strings (equal length, so lexicographic == numeric), and the id is text by
 * definition. Returns the predicate plus the parameters it needs, so the page
 * query and the `hasMore` probe cannot disagree about what "older" means.
 */
function messageCursor(
  stamp: string | undefined,
  beforeId: string | undefined,
): { where: string; params: string[] } {
  if (stamp === undefined || stamp === '') return { where: '', params: [] };
  if (beforeId === undefined || beforeId === '') {
    return { where: 'created_at < ?', params: [stamp] };
  }
  return {
    where: '(created_at < ? OR (created_at = ? AND id < ?))',
    params: [stamp, stamp, beforeId],
  };
}

/**
 * Read a page of messages for one session, newest-last, with media, segments
 * and footer reconstructed from persisted metadata.
 */
export function loadSessionMessages(
  db: Database.Database,
  sessionId: string,
  options: LoadSessionMessagesOptions,
): { messages: any[]; hasMore: boolean } {
  const { limit, before, beforeId, getFooterConfig } = options;
  // Fetch the latest (or cursor-bounded) N messages, returned in ASC order
  // (oldest first) so the frontend renders oldest at top, newest at bottom.
  // Both orderings carry the id so a group of same-millisecond messages is
  // walked deterministically instead of in whatever order the index yields.
  const cursor = messageCursor(
    before !== undefined && Number.isFinite(before) ? String(before) : undefined,
    beforeId,
  );
  const where = cursor.where === '' ? '' : ` AND ${cursor.where}`;
  const messages = db
    .prepare(
      `
      SELECT * FROM (
        SELECT * FROM messages WHERE session_id = ?${where}
        ORDER BY created_at DESC, id DESC LIMIT ?
      ) ORDER BY created_at ASC, id ASC
    `,
    )
    .all(sessionId, ...cursor.params, limit) as any[];

  // Determine if there are more messages beyond the oldest one we returned.
  // Same predicate as the page itself, anchored on the oldest returned row: a
  // `created_at <` comparison here would report "no more" while a same-ms
  // sibling is still waiting on the next page.
  let hasMore = false;
  if (messages.length === limit && messages.length > 0) {
    const oldest = messages[0] as { created_at: string | number; id: string };
    const next = messageCursor(String(oldest.created_at), oldest.id);
    const row = db
      .prepare(`SELECT 1 AS one FROM messages WHERE session_id = ? AND ${next.where} LIMIT 1`)
      .get(sessionId, ...next.params);
    hasMore = row !== undefined;
  }

  const formattedMessages = formatMessageRows(messages, getFooterConfig);

  return { messages: formattedMessages, hasMore };
}

/**
 * Format raw `messages` rows into the API/UI shape: stripped time prefixes,
 * media collected from the three sources, segments rebuilt from block order and
 * a footer taken from the snapshot stored with the message.
 *
 * Exported because the search-context route needs the exact same projection for
 * a *window* of messages around a hit — a second implementation would drift on
 * the first media or footer tweak.
 */
export function formatMessageRows(rows: any[], getFooterConfig?: () => FooterConfig): any[] {
  return rows.map((m) => {
    let meta: Record<string, unknown> | null = null;
    try {
      meta = m.metadata ? JSON.parse(String(m.metadata)) : null;
    } catch {
      /* ignore */
    }

    // Strip injected date/time prefix from user messages.
    // The prefix is prepended with \n\n by context-transform, so ^ alone
    // won't match — use ^[\s\n]* to skip leading whitespace.
    let content = m.content;
    if (m.role === 'user') {
      content = stripXmlTag(content, 'system-reminder').trimStart();
      content = content
        .replace(/^[\s\n]*\[当前(时间|日期):[^\]]+\][\s\n]*/g, '')
        .replace(/^[\s\n]*\[Current (time|date):[^\]]+\][\s\n]*/gi, '');
    }

    // Collect images/files from 3 sources:
    // 1. Persisted metadata (compact, written by persistMessages)
    // 2. Content markdown ![alt](url) patterns
    // 3. Tool call outputs (webui_send_media embeds ![img](url) in results)
    const images: { url: string; alt?: string }[] = [];
    const files: { name: string; path: string }[] = [];
    const seenUrls = new Set<string>();

    // Source 1: persisted metadata images/files
    const metaImages = meta?.images as Array<{ url: string; alt?: string }> | undefined;
    if (metaImages) {
      for (const img of metaImages) {
        if (img && isChatMediaUrl(img.url) && !seenUrls.has(img.url)) {
          seenUrls.add(img.url);
          images.push(img);
        }
      }
    }
    const metaFiles = meta?.files as Array<{ name: string; path: string }> | undefined;
    if (metaFiles) {
      for (const f of metaFiles) {
        if (!seenUrls.has(f.path)) {
          seenUrls.add(f.path);
          files.push(f);
        }
      }
    }

    const extractImagesFrom = (text: string) => {
      const imgRegex = /!\[([^\[\]]*)\]\(([^)\s]+)\)/g;
      let m: RegExpExecArray | null;
      while ((m = imgRegex.exec(text)) !== null) {
        const url = m[2];
        // Arbitrary external URLs (e.g. image links inside web_search result
        // snippets) must never be surfaced as chat images.
        if (!isChatMediaUrl(url)) continue;
        if (!seenUrls.has(url)) {
          seenUrls.add(url);
          images.push({ alt: m[1] || undefined, url });
        }
      }
    };

    const extractFilesFrom = (text: string) => {
      // Match [name](url) for serve/download/dl URLs (webui_send_media output)
      const linkRegex =
        /\[([^\]]+)\]\((\/(?:api\/files\/(?:serve|download)\?[^)\s]+|dl\/[^)\s]+|desktop-bridge-download\?[^)\s]+))\)/g;
      let m: RegExpExecArray | null;
      while ((m = linkRegex.exec(text)) !== null) {
        const url = m[2];
        if (!seenUrls.has(url)) {
          seenUrls.add(url);
          files.push({ name: m[1], path: url });
        }
      }
    };

    // Source 2+3: content + tool call outputs
    if (m.role === 'assistant') {
      extractImagesFrom(content);
      extractFilesFrom(content);
      const toolCalls = meta?.tool_calls as Array<{ name?: string; output?: string }> | undefined;
      if (toolCalls) {
        for (const tc of toolCalls) {
          // Only media-emitting tools may surface images in chat (web_search
          // etc. return untrusted snippets full of image links).
          if (tc.output && tc.name && CHAT_MEDIA_TOOL_NAMES.has(tc.name)) {
            extractImagesFrom(tc.output);
            extractFilesFrom(tc.output);
          }
        }
      }
    } else if (m.role === 'user') {
      // User-uploaded attachments are stored as markdown [name](url) links
      extractFilesFrom(content);
    }

    // Refresh expired /dl/ tokens with the current signing key so images
    // and files keep working across page refreshes, long-lived sessions
    // and restarts (the key changes per process start, invalidating any
    // tokens persisted in history).
    refreshPersistedDownloadUrls(images, files);

    const result: any = {
      id: m.id,
      session_id: m.session_id,
      role: m.role,
      content,
      tool_calls: meta?.tool_calls,
      created_at: m.created_at,
      ...(meta?.approval ? { approval: meta.approval } : {}),
      ...(meta?.userQuestion ? { userQuestion: meta.userQuestion } : {}),
      ...(meta?.skill_activated ? { skill_activated: meta?.skill_activated } : {}),
      ...(meta?.error ? { error: meta.error } : {}),
      ...(images.length > 0 ? { images } : {}),
      ...(files.length > 0 ? { files } : {}),
    };

    // Reconstruct segments from persisted block-order metadata so the
    // frontend can render text and tool calls interleaved (same as during
    // streaming). Segments store {type: 'text', content} and
    // {type: 'tool_call', id} entries; tool_call entries are resolved
    // against meta.tool_calls to build full ToolCall objects.
    if (meta?.segments && Array.isArray(meta.segments) && meta.segments.length > 0) {
      const toolCallsById = new Map<string, Record<string, unknown>>();
      const toolCalls = meta?.tool_calls as
        Array<{ id: string; name: string; arguments: Record<string, unknown> }> | undefined;
      if (toolCalls) {
        for (const tc of toolCalls) {
          if (tc.id) toolCallsById.set(tc.id, tc as unknown as Record<string, unknown>);
        }
      }

      const segments: Array<{
        type: 'text' | 'tool_call' | 'skill';
        content?: string;
        toolCall?: Record<string, unknown>;
        name?: string;
      }> = [];
      for (const seg of meta.segments as Array<{
        type: string;
        content?: string;
        id?: string;
        name?: string;
      }>) {
        if (seg.type === 'text') {
          segments.push({ type: 'text', content: seg.content || '' });
        } else if (seg.type === 'skill') {
          segments.push({ type: 'skill', name: seg.name || '' });
        } else if (seg.type === 'tool_call' && seg.id) {
          const tc = toolCallsById.get(seg.id);
          if (tc) {
            segments.push({
              type: 'tool_call',
              toolCall: {
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments,
                // Historical tool calls completed for this response to exist
                status: 'success',
              },
            });
          }
        }
      }

      if (segments.length > 0) {
        result.segments = segments;
      }
    }

    // Reconstruct footer from persisted metadata.
    // Use the footer config SNAPSHOT stored at message-save time so that
    // each message retains its original footer display regardless of
    // subsequent global config changes. Falls back to the current config
    // for messages saved before footer config was persisted.
    if (meta && (meta.usage || meta.model || meta.elapsed)) {
      const fc = (meta.footerConfig as FooterConfig | undefined) ??
        getFooterConfig?.() ?? {
          showAgentName: true,
          showModel: true,
          showCompleted: false,
          showElapsed: true,
          showUsage: false,
          showCacheHitRate: false,
        };
      result.footer = {
        agentName: fc.showAgentName ? (meta.agentName as string | undefined) : undefined,
        model: fc.showModel ? (meta.model as string | undefined) : undefined,
        elapsed: fc.showElapsed ? (meta.elapsed as number | undefined) : undefined,
        usage: meta.usage as {
          input?: number;
          output?: number;
          cacheRead?: number;
          cacheWrite?: number;
        },
        showUsage: fc.showUsage ?? false,
        showCacheHitRate: fc.showCacheHitRate ?? false,
      };
    }

    return result;
  });
}

/** Messages returned on each side of a search hit by {@link loadMessageContext}. */
const DEFAULT_CONTEXT_RADIUS = 6;

/**
 * A window of a session's messages centred on one hit.
 *
 * Search results are snippets: a matching sentence with no conversation around
 * it is often unreadable ("Excel" matched in a tool output says nothing about
 * what was asked). Rather than making the caller page the whole transcript, this
 * returns the hit plus `radius` messages on each side, already formatted exactly
 * like a normal transcript so the UI renders it with the same message component.
 *
 * `truncatedStart`/`truncatedEnd` tell the UI whether "open full session" is the
 * only way to see more — they are computed with COUNT queries so the answer
 * stays correct when the hit is the first or last message.
 */
export function loadMessageContext(
  db: Database.Database,
  sessionId: string,
  messageId: string,
  options: { radius?: number; getFooterConfig?: () => FooterConfig } = {},
): {
  messages: any[];
  focusId: string | null;
  truncatedStart: boolean;
  truncatedEnd: boolean;
} {
  const radius = Math.min(Math.max(1, options.radius ?? DEFAULT_CONTEXT_RADIUS), 50);

  // SELECT *: the anchor row is part of the returned window, so it must carry
  // every column the formatter reads (content, role, metadata) — a projection
  // here would silently return a hole in the middle of the conversation.
  const anchor = db
    .prepare('SELECT * FROM messages WHERE id = ? AND session_id = ?')
    .get(messageId, sessionId) as any | undefined;

  // A stale index row (message deleted, or the id belongs to another session)
  // must not fail the search UI: fall back to the newest page of the session.
  if (!anchor) {
    const rows = db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?
         ) ORDER BY created_at ASC`,
      )
      .all(sessionId, radius * 2 + 1) as any[];
    return {
      messages: formatMessageRows(rows, options.getFooterConfig),
      focusId: null,
      truncatedStart: hasMessagesBefore(db, sessionId, rows[0]?.created_at),
      truncatedEnd: false,
    };
  }

  const before = db
    .prepare(
      `SELECT * FROM messages WHERE session_id = ? AND created_at < ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(sessionId, anchor.created_at, radius) as any[];
  const after = db
    .prepare(
      `SELECT * FROM messages WHERE session_id = ? AND created_at > ?
       ORDER BY created_at ASC LIMIT ?`,
    )
    .all(sessionId, anchor.created_at, radius) as any[];

  // ASC order including the anchor, matching a transcript's reading direction.
  const rows = [...before.reverse(), anchor, ...after] as any[];

  return {
    messages: formatMessageRows(rows, options.getFooterConfig),
    focusId: anchor.id,
    truncatedStart:
      before.length === radius && hasMessagesBefore(db, sessionId, before[0]?.created_at),
    truncatedEnd:
      after.length === radius &&
      (
        db
          .prepare('SELECT COUNT(*) AS cnt FROM messages WHERE session_id = ? AND created_at > ?')
          .get(sessionId, after[after.length - 1]?.created_at) as { cnt: number }
      ).cnt > 0,
  };
}

/** Whether any message of the session predates `createdAt`. */
function hasMessagesBefore(db: Database.Database, sessionId: string, createdAt: unknown): boolean {
  if (createdAt === undefined) return false;
  return (
    (
      db
        .prepare('SELECT COUNT(*) AS cnt FROM messages WHERE session_id = ? AND created_at < ?')
        .get(sessionId, createdAt) as { cnt: number }
    ).cnt > 0
  );
}

/**
 * Session title for rows written before v9, where the only copy lived in the
 * `metadata` JSON blob (the `title` column is the current home).
 *
 * Shared by the inbox and the search results: both label sessions the same way,
 * and two copies of this parse would eventually disagree on a malformed blob.
 */
export function titleFromMetadata(metadata: string | null): string | undefined {
  if (!metadata) return undefined;
  try {
    const parsed = JSON.parse(String(metadata)) as { title?: unknown };
    return typeof parsed?.title === 'string' ? parsed.title : undefined;
  } catch {
    return undefined;
  }
}
