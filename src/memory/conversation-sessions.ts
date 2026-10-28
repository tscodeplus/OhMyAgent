/**
 * IM conversation sessions — the split between a chat *slot* and a *transcript*.
 *
 * A channel's session key is the transport handle (`oc_…`, `telegram:123`). That
 * key is what `/stop`, the approval store, the card router and the chat queue use
 * to find the live turn of this chat, and it has always doubled as the session
 * row id. Doubling is what made `/new` a lie: it cleared the runtime while the
 * transcript kept the same id, so the inbox stayed one row forever.
 *
 * This module keeps the two roles apart:
 *   - **slot** — the chat handle, unchanged, still the runtime/queue/approval key;
 *   - **session id** — the transcript, `slot` for the first conversation of that
 *     chat and `slot~2`, `slot~3`, … for later ones (see `start`).
 *
 * The first conversation keeping the bare slot is deliberate: every session row
 * written before this module existed already satisfies `id = chat_id = slot`, so
 * there is nothing to migrate and old transcripts stay reachable.
 *
 * `sessions.chat_id` is the registry: it records the slot, so "which transcript
 * is current for this chat" is one indexed lookup rather than another table that
 * could drift out of sync with the rows it describes.
 */

import type Database from 'better-sqlite3';
import { inferChannel, type SessionChannel } from './session-channel.js';
import { SessionRepository, type Session } from './repositories/session-repository.js';

/**
 * Separator between slot and generation.
 *
 * `#` is the natural reading (`chat #2`) but unusable: a browser treats it as the
 * start of the URL fragment, so `/api/inbox/oc_x#2/messages` would arrive as
 * `/api/inbox/oc_x` and the WebUI router would match the wrong id. `~` is
 * unreserved in RFC 3986 — it survives a path segment untouched, and it keeps
 * the `oc_` / `telegram:` prefixes `inferChannel` matches on.
 */
export const CONVERSATION_SEPARATOR = '~';

/** Trailing `~<n>` marking a generation. Generation 1 has no suffix. */
const GENERATION_SUFFIX = new RegExp(`\\${CONVERSATION_SEPARATOR}(\\d+)$`);

/**
 * Channels whose session key is also the transport conversation handle, and that
 * therefore accumulate messages per chat and need `/new` to split them.
 *
 * WebUI sessions are one per chat by construction (the UI creates them) and their
 * `chat_id` carries the project (`webui:<projectId>`), so rotating them would
 * invent session ids nobody navigates to.
 */
const CONVERSATION_CHANNELS: readonly SessionChannel[] = ['feishu', 'telegram', 'wechat', 'qq'];

/** Longest accepted conversation title; the inbox row renders one line. */
export const MAX_CONVERSATION_TITLE_CHARS = 80;

/** The chat handle behind a session id: `oc_x~3` → `oc_x`. */
export function conversationSlot(sessionId: string): string {
  return sessionId.replace(GENERATION_SUFFIX, '');
}

/** 1 for a bare slot (or anything unrecognised), `n` for `…~n`. */
export function conversationGeneration(sessionId: string): number {
  const match = GENERATION_SUFFIX.exec(sessionId);
  if (!match) return 1;
  const parsed = Number.parseInt(match[1]!, 10);
  return Number.isFinite(parsed) && parsed >= 2 ? parsed : 1;
}

/** Whether `/new` may split this slot into a new transcript. */
export function isConversationChannel(sessionId: string): boolean {
  return CONVERSATION_CHANNELS.includes(inferChannel(conversationSlot(sessionId)));
}

/**
 * Normalise a user-supplied title, or null when there is nothing to store.
 *
 * Collapses whitespace because the title is rendered on one line: a pasted
 * multi-line title would be truncated mid-sentence with a stray newline before
 * the ellipsis. Truncation keeps the column small enough for the sidebar, which
 * clips anyway — storing 4 KB to then show 20 characters helps nobody.
 */
export function normalizeConversationTitle(raw: string | undefined): string | null {
  if (!raw) return null;
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  return collapsed.length > MAX_CONVERSATION_TITLE_CHARS
    ? collapsed.slice(0, MAX_CONVERSATION_TITLE_CHARS).trimEnd()
    : collapsed;
}

export interface StartedConversation {
  /** Session id of the new transcript. */
  id: string;
  slot: string;
  generation: number;
  title: string | null;
}

export interface StartConversationOptions {
  title?: string | null;
  /** Transport handle, when the caller knows it (keeps the inbox header honest). */
  externalChatId?: string | null;
}

export class ConversationSessions {
  private readonly db: Database.Database;
  private readonly sessions: SessionRepository;

  constructor(db: Database.Database) {
    this.db = db;
    this.sessions = new SessionRepository(db);
  }

  /**
   * The transcript a slot is currently writing to.
   *
   * Called once per incoming IM message. A chat with no history yet resolves to
   * its own slot, which is exactly the id the first message will create.
   */
  resolve(slotOrSessionId: string): string {
    const slot = conversationSlot(slotOrSessionId);
    if (!isConversationChannel(slot)) return slotOrSessionId;

    let best = slot;
    let bestGeneration = 0;
    for (const row of this.rowsForSlot(slot)) {
      const generation = conversationGeneration(row.id);
      if (generation > bestGeneration) {
        best = row.id;
        bestGeneration = generation;
      }
    }
    return best;
  }

  /** Title of the transcript a slot currently writes to, if it has one. */
  currentTitle(slotOrSessionId: string): string | null {
    const session = this.sessions.findById(this.resolve(slotOrSessionId));
    return session?.title ?? null;
  }

  /**
   * Open the next transcript for a slot and return it.
   *
   * Returns null for channels that do not split (WebUI), so the caller can keep
   * its previous `/new` behaviour instead of inventing an id nobody can open.
   *
   * The whole read-max-then-insert runs in one transaction: two `/new` commands
   * landing in the same tick would otherwise both compute the same generation and
   * the second insert would fail on the primary key.
   */
  start(
    slotOrSessionId: string,
    options: StartConversationOptions = {},
  ): StartedConversation | null {
    const slot = conversationSlot(slotOrSessionId);
    if (!isConversationChannel(slot)) return null;

    const title = normalizeConversationTitle(options.title ?? undefined);
    const previous = this.newestRow(slot);
    const channel = inferChannel(slot, previous?.external_chat_id ?? slot);

    const insert = this.db.transaction((): StartedConversation => {
      const generation = this.rowsForSlot(slot).reduce(
        (max, row) => Math.max(max, conversationGeneration(row.id)),
        0,
      );
      // Generation 1 is the slot itself (and cannot happen via /new unless the
      // chat never wrote a message), so the suffix starts at 2.
      const id = generation === 0 ? slot : `${slot}${CONVERSATION_SEPARATOR}${generation + 1}`;
      this.sessions.create({
        id,
        chat_id: slot,
        user_id: previous?.user_id ?? 'unknown',
        channel,
        external_chat_id: options.externalChatId ?? previous?.external_chat_id ?? null,
        title,
      });
      return { id, slot, generation: generation === 0 ? 1 : generation + 1, title };
    });

    return insert();
  }

  /** Retitle the transcript a slot currently writes to. False when there is none. */
  rename(slotOrSessionId: string, rawTitle: string | undefined): string | null {
    const title = normalizeConversationTitle(rawTitle);
    if (!title) return null;
    const id = this.resolve(slotOrSessionId);
    if (!this.sessions.findById(id)) return null;
    this.sessions.setTitle(id, title);
    return title;
  }

  /** Every transcript row of one slot, oldest id first — the generation order. */
  private rowsForSlot(slot: string): Session[] {
    return this.sessions.findByChatId(slot);
  }

  private newestRow(slot: string): Session | undefined {
    const rows = this.rowsForSlot(slot);
    let best: Session | undefined;
    for (const row of rows) {
      if (!best || conversationGeneration(row.id) > conversationGeneration(best.id)) best = row;
    }
    return best;
  }
}
