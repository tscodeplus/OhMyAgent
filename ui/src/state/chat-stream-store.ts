/**
 * Session-scoped chat stream store.
 *
 * The stream does not belong to a component: everything a turn streams —
 * assistant draft text, tool cards, approval cards, the "thinking" indicator —
 * lives here, keyed by session, for as long as the turn runs. A session switch,
 * a route change (Settings, Inbox) or a dropped transport therefore only stops
 * *rendering* it; the reader keeps consuming, and coming back re-renders the
 * live bubble at its current position instead of a blank placeholder.
 *
 * Recovery has two layers, matching the server's `chat-stream-hub`:
 *   1. In-process: the store owns one SSE reader per session, so no component
 *      lifecycle can abort a running turn.
 *   2. Cross-process (page reload, tab closed/reopened, connection death):
 *      `ensureAttached()` opens `GET /api/projects/:id/chat/stream`, which
 *      answers with a compacted `resume` baseline of the in-flight turn. The
 *      baseline events are replayed through the same reducer as live events,
 *      then the live tail continues on that connection.
 */
import { createSSEClient, type SSEEvent } from '../utils/sse-client';
import i18n from '../i18n/config';
import { devLog } from '../utils/logger';
import { CHAT_MEDIA_TOOL_NAMES, isChatMediaUrl } from '../utils/chatMedia';
import { AssistantTimeline } from './assistant-timeline';
import type {
  Message,
  MessageApproval,
  MessageFile,
  MessageFooter,
  MessageImage,
  MessageSegment,
  ToolCall,
  UserQuestion,
} from '../types/session';

const sseClient = createSSEClient();

/** Throttle interval for text_delta → subscriber notification (~20fps). */
const DELTA_FLUSH_INTERVAL_MS = 50;

/**
 * Silence (including the server's 15s keepalive pings) beyond which a stream
 * counts as dead. A healthy connection cannot be silent this long while a turn
 * runs — a backgrounded tab, a suspended mobile WebView and a half-open TCP
 * socket all can, and re-attaching recovers the turn.
 */
const STREAM_IDLE_TIMEOUT_MS = 45_000;

/**
 * Shorter silence bar for an explicit wake-up (phone resumed, PWA restored
 * from bfcache, network regained): the server pings every 15s, so 20s of
 * silence at that moment means the connection did not survive. Re-attaching
 * is cheap and lands on the baseline, so bias toward repairing quickly.
 */
const WAKE_IDLE_TIMEOUT_MS = 20_000;

/**
 * Bounded re-attach attempts after a transport failure. Mobile connectivity
 * outages (cell hand-off, tunnel, suspended WebView) routinely last longer
 * than a desktop blip, so the window spans ~30s: 1s, 2s, 4s, 8s, 8s, 8s. A
 * regained connection (`online`) short-circuits the wait entirely.
 */
const MAX_RESUME_ATTEMPTS = 6;

/** Minimum gap between two cheap "is a turn running?" probes for a session. */
const PROBE_MIN_INTERVAL_MS = 10_000;

/** How long a settled session's stream state is kept while nobody views it. */
const SETTLED_RETENTION_MS = 10 * 60_000;

export interface ChatStreamSnapshot {
  /** Streaming-only bubbles: assistant drafts, tool cards, approval/question cards. */
  messages: Message[];
  /** A turn is running — the composer steers instead of starting a new turn. */
  sending: boolean;
  /** The gateway accepted the turn but no content has arrived yet. */
  thinking: boolean;
  /** Transient retry/fallback status line (null = hidden). */
  retryStatus: string | null;
  /** A live SSE connection (POST or re-attach) is attached right now. */
  live: boolean;
}

const EMPTY_SNAPSHOT: ChatStreamSnapshot = {
  messages: [],
  sending: false,
  thinking: false,
  retryStatus: null,
  live: false,
};

/** Parameters of one turn started from the chat input. */
export interface SendTurnParams {
  /** Full message content (text plus any file references). */
  content: string;
  /** Client-generated user message id — reused as the persisted message id. */
  clientMsgId: string;
  /** Local echo bubble shown immediately. */
  userMessage: Message;
  agentId?: string;
  /** "provider/modelId" ref; null = back on the configured defaults. */
  model: string | null;
  reasoningLevel: string | null;
  /** Keep the existing streamed content (slash command sent mid-turn). */
  preserveContent?: boolean;
}

/** Random UUID v4 with a fallback for non-secure contexts. */
function uid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
}

/**
 * Duplicate detection between a live streaming bubble and the persisted API
 * snapshot (used when ids differ, e.g. assistant bubbles).
 * Only matches when the persisted copy was created at/after the live bubble
 * started (persist happens at turn end) and contents overlap. Short contents
 * are only matched exactly to avoid false positives like "好" vs "好的…".
 */
function fuzzyDuplicate(m: Message, fetched: Message[]): boolean {
  // Assistant-only: user messages dedupe by exact id (clientMsgId echo).
  // Fuzzy-matching users is risky — two identical short messages sent in
  // quick succession (e.g. "继续") would falsely prune the live copy.
  if (m.role !== 'assistant') return false;
  const t = new Date(m.created_at).getTime();
  return fetched.some((f) => {
    if (f.role !== 'assistant' || !f.content) return false;
    const ft = new Date(f.created_at).getTime();
    if (Math.abs(ft - t) > 30_000) return false;
    if (ft < t - 2_000) return false;
    if (f.content === m.content) return true;
    const shorter = Math.min(f.content.length, m.content.length);
    if (shorter < 16) return false;
    return f.content.startsWith(m.content) || m.content.startsWith(f.content);
  });
}

/** True for cards that exist only while streaming and must survive pruning. */
function isStreamOnlyCard(m: Message): boolean {
  if (m.approval) return true;
  return !!m.userQuestion && m.userQuestion.status !== 'answered';
}

/**
 * Stream state of one session: the reducer, the transport, and the snapshot
 * React reads. One instance per session, created on demand.
 */
class SessionStream {
  readonly sessionId: string;
  projectId: string;

  /** Streaming-only bubbles (merged exactly like the old ChatView handler). */
  private messages: Message[] = [];

  private sendingFlag = false;
  private thinkingFlag = false;
  private retryStatusValue: string | null = null;
  private liveFlag = false;

  // ── Current turn accumulator (previously ChatInput refs) ──
  private assistantId = '';
  /**
   * Ordered text/tool/skill/media run of the current bubble. Fragment
   * boundaries flush explicitly, so a replayed baseline (no throttled flush
   * between events) produces exactly the same segments as live streaming.
   */
  private timeline = new AssistantTimeline();
  private assistantCreatedAt = '';
  private toolCalls: ToolCall[] = [];
  private runningTools = new Map<string, ToolCall>();
  private steerBubble = false;
  private approvalMessages = new Map<string, Message>();
  private questionMessages = new Map<string, Message>();
  /** Turn nesting count — `done` only stops the spinner on the last one. */
  private activeTurns = 0;

  /** Bubbles whose turn emitted done/error: persisted before the event. */
  private completedBubbles = new Set<string>();

  private abort: AbortController | null = null;
  /**
   * Generation of the attached transport. Handlers from a superseded or
   * aborted transport must not touch state: aborting a reader resolves its
   * callbacks a microtask later, which can land after a new turn started.
   */
  private transportGen = 0;
  private deltaTimer: ReturnType<typeof setTimeout> | null = null;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private gcTimer: ReturnType<typeof setTimeout> | null = null;
  private resumeAttempts = 0;
  /** Last time the server proved the connection is alive (event or ping). */
  private lastActivity = 0;
  /** Timestamp of the last cheap live-turn probe (throttles re-probing). */
  private lastProbeAt = 0;
  /**
   * True while a `resume` baseline is being replayed. A record that holds more
   * than one turn (the first one settled, a steer opened the next) replays its
   * earlier `done`/`error` in the middle of the log — that must update the
   * bubbles without tearing down the transport the replay itself arrived on.
   */
  private replaying = false;
  /** Time the current wake-up check started from — avoids re-attach storms. */
  private lastVisibleCheck = 0;

  private listeners = new Set<() => void>();
  private turnListeners = new Set<() => void>();

  private revision = 0;
  private messagesRevision = 0;
  private cached: { revision: number; snapshot: ChatStreamSnapshot } | null = null;
  private cachedMessages: Message[] = [];
  private cachedMessagesRevision = -1;

  constructor(sessionId: string, projectId: string) {
    this.sessionId = sessionId;
    this.projectId = projectId;
  }

  // ── Subscription (React) ──

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (this.gcTimer) {
      clearTimeout(this.gcTimer);
      this.gcTimer = null;
    }
    if (this.listeners.size === 1) {
      // Someone is looking again: repair a stream that died while unwatched
      // (backgrounded tab, route away, suspended WebView) so the conversation
      // picks up where the turn actually is.
      if (this.sendingFlag && !this.liveFlag && !this.resumeTimer) this.scheduleResume();
      else this.checkAlive(true);
    }
    return () => {
      this.listeners.delete(listener);
      this.scheduleGc();
    };
  }

  onTurnComplete(listener: () => void): () => void {
    this.turnListeners.add(listener);
    return () => this.turnListeners.delete(listener);
  }

  getSnapshot(): ChatStreamSnapshot {
    if (this.cached && this.cached.revision === this.revision) return this.cached.snapshot;
    if (this.cachedMessagesRevision !== this.messagesRevision) {
      this.cachedMessages = Object.freeze([...this.messages]) as Message[];
      this.cachedMessagesRevision = this.messagesRevision;
    }
    const snapshot: ChatStreamSnapshot = {
      messages: this.cachedMessages,
      sending: this.sendingFlag,
      thinking: this.thinkingFlag,
      retryStatus: this.retryStatusValue,
      live: this.liveFlag,
    };
    this.cached = { revision: this.revision, snapshot };
    return snapshot;
  }

  isSending(): boolean {
    return this.sendingFlag;
  }

  /** True while a transport is attached or the store still expects events. */
  isBusy(): boolean {
    return this.sendingFlag || this.liveFlag;
  }

  private notify(): void {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }

  private notifyTurnComplete(): void {
    for (const listener of this.turnListeners) listener();
  }

  private messagesChanged(): void {
    this.messagesRevision += 1;
  }

  // ── Public actions ──

  /** Start a turn: local echo, then the POST SSE stream. */
  send(params: SendTurnParams): void {
    devLog('[chatStream] starting turn', {
      sessionId: this.sessionId.slice(0, 8),
      preview: params.content.slice(0, 40),
    });
    // A new turn supersedes whatever this session's previous stream was.
    this.abortTransport();
    this.clearTimers();
    this.resumeAttempts = 0;
    this.sendingFlag = true;
    this.thinkingFlag = false;
    this.retryStatusValue = null;
    this.lastActivity = Date.now();
    if (!params.preserveContent) {
      // Regular send: the new user message clears the previous turn's bubbles
      // (pending approval/question cards are kept by the merge below).
      this.applyMessages([params.userMessage], true);
    } else {
      this.applyMessages([params.userMessage], false);
    }

    this.lastProbeAt = Date.now();
    this.liveFlag = true;
    this.notify();

    const url = `/api/projects/${this.projectId}/chat`;
    this.openTransport((handlers) =>
      sseClient.start(
        url,
        {
          sessionId: this.sessionId,
          message: params.content,
          clientMsgId: params.clientMsgId,
          agentId: params.agentId,
          // Null (not undefined) signals "user is back on the defaults" — the
          // server clears the session pin. A value pins it to the session.
          model: params.model,
          reasoningLevel: params.reasoningLevel,
        },
        handlers.onEvent,
        handlers.onError,
        handlers.onChunk,
        handlers.onEnd,
      ),
    );
  }

  /**
   * Echo a message that is not carried by the SSE stream itself (steer,
   * slash command routed through /chat/steer).
   */
  echo(messages: Message[], clearPrevious = false): void {
    this.applyMessages(messages, clearPrevious);
  }

  /**
   * Prepare the bubble for a steer response. The original turn's `done` may
   * never arrive (the steer interrupted it), so the counter resets and this
   * turn's `done` is what ends the spinner.
   */
  beginSteerTurn(): void {
    this.activeTurns = 0;
    this.beginTurn();
    this.steerBubble = true;
    this.sendingFlag = true;
    this.thinkingFlag = false;
    this.notify();
  }

  /**
   * Attach to an in-flight turn recorded by the server (page load, woken
   * phone, restored PWA, another tab, network regained).
   *
   * `liveOnly` adds `probe=1`, which makes the server answer `idle` for a turn
   * that already settled instead of replaying it. Cheap re-probes therefore
   * cannot resurrect a finished reply over the fetched history.
   */
  resume(opts: { liveOnly?: boolean } = {}): void {
    if (this.liveFlag) return;
    this.lastProbeAt = Date.now();
    this.liveFlag = true;
    this.notify();

    const url =
      `/api/projects/${this.projectId}/chat/stream` +
      `?sessionId=${encodeURIComponent(this.sessionId)}` +
      (opts.liveOnly ? '&probe=1' : '');
    devLog('[chatStream] re-attaching', { sessionId: this.sessionId.slice(0, 8) });

    this.openTransport((handlers) =>
      sseClient.open(url, handlers.onEvent, handlers.onError, handlers.onChunk, handlers.onEnd),
    );
  }

  /** True when a live-turn probe ran recently enough to skip another one. */
  probeIsFresh(): boolean {
    return Date.now() - this.lastProbeAt < PROBE_MIN_INTERVAL_MS;
  }

  /**
   * Network regained: retry a stalled stream right away instead of waiting out
   * the backoff. Resets the attempt budget — the previous failures were the
   * network's, not the server's.
   */
  retryNow(): void {
    if (!this.sendingFlag || this.liveFlag) return;
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    this.resumeAttempts = 0;
    this.resume();
  }

  /**
   * Prune streaming bubbles the API snapshot superseded. A bubble is dropped
   * only when its persisted copy is known to exist: exact id (user messages
   * share the clientMsgId), a completed turn (persisted before done), or a
   * conservative content overlap for connections lost without a terminal event.
   */
  pruneAfterRefetch(fetched: Message[]): void {
    const fetchedIds = new Set(fetched.map((m) => m.id));
    const kept = this.messages.filter((m) => {
      if (isStreamOnlyCard(m)) return true;
      if (fetchedIds.has(m.id)) return false;
      if (this.completedBubbles.has(m.id)) return false;
      if (fetched.length > 0 && fuzzyDuplicate(m, fetched)) return false;
      return true;
    });
    if (kept.length !== this.messages.length) {
      devLog('[chatStream] pruned streaming bubbles', {
        before: this.messages.length,
        after: kept.length,
      });
      this.setMessages(kept);
    }
    if (this.completedBubbles.size > 100) this.completedBubbles.clear();
  }

  /**
   * Wake-up check: is the stream we believe is live actually still alive?
   * @param aggressive - called from an explicit wake-up (visibility, pageshow,
   *   online) rather than the periodic sweep: use the shorter silence bar.
   */
  checkAlive(aggressive = false): void {
    if (!this.liveFlag || !this.sendingFlag) return;
    if (this.listeners.size === 0) return; // nobody is watching — leave it be
    const now = Date.now();
    if (now - this.lastVisibleCheck < 5_000) return;
    this.lastVisibleCheck = now;
    const idleLimit = aggressive ? WAKE_IDLE_TIMEOUT_MS : STREAM_IDLE_TIMEOUT_MS;
    if (now - this.lastActivity < idleLimit) return;
    devLog('[chatStream] stream looks dead after wake-up — re-attaching', {
      sessionId: this.sessionId.slice(0, 8),
      idleMs: now - this.lastActivity,
    });
    this.abortTransport();
    this.scheduleResume();
  }

  /** Drop everything (tests, session deletion). */
  dispose(): void {
    this.abortTransport();
    this.clearTimers();
    if (this.gcTimer) clearTimeout(this.gcTimer);
    this.listeners.clear();
    this.turnListeners.clear();
  }

  // ── Transport plumbing ──

  private touchActivity(): void {
    this.lastActivity = Date.now();
  }

  /**
   * Attach one transport, fencing its callbacks to the current generation so a
   * superseded stream cannot resume, notify or end the turn that replaced it.
   */
  private openTransport(
    open: (handlers: {
      onEvent: (event: SSEEvent) => void;
      onError: (error: Error) => void;
      onChunk: () => void;
      onEnd: () => void;
    }) => AbortController,
  ): void {
    this.transportGen += 1;
    const gen = this.transportGen;
    this.abort = open({
      onEvent: (event) => {
        if (gen !== this.transportGen) return;
        this.handleEvent(event);
      },
      onError: (error) => {
        if (gen !== this.transportGen) return;
        this.onTransportError(error);
      },
      onChunk: () => {
        if (gen !== this.transportGen) return;
        this.touchActivity();
      },
      onEnd: () => {
        if (gen !== this.transportGen) return;
        this.onTransportEnd();
      },
    });
  }

  private abortTransport(): void {
    // Bump the generation first: the abort resolves the reader callbacks
    // asynchronously and they must see a stale generation by then.
    this.transportGen += 1;
    if (this.deltaTimer) {
      clearTimeout(this.deltaTimer);
      this.deltaTimer = null;
    }
    const abort = this.abort;
    this.abort = null;
    this.liveFlag = false;
    abort?.abort();
  }

  private clearTimers(): void {
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
  }

  private onTransportError(error: Error): void {
    devLog('[chatStream] transport error', { message: error.message });
    this.liveFlag = false;
    if (!this.sendingFlag) {
      this.notify();
      return;
    }
    this.scheduleResume();
  }

  /** The response body ended (server closed, network died, or abort). */
  private onTransportEnd(): void {
    this.liveFlag = false;
    if (this.sendingFlag) {
      // No terminal event arrived — the turn may well still be running on the
      // gateway. Re-attach and continue from its baseline.
      this.scheduleResume();
    } else {
      this.notify();
      this.scheduleGc();
    }
  }

  private scheduleResume(): void {
    if (this.resumeTimer || !this.sendingFlag) return;
    if (this.resumeAttempts >= MAX_RESUME_ATTEMPTS) {
      devLog('[chatStream] giving up on re-attach — waiting for turn completion');
      this.finishTurnWithoutStream();
      return;
    }
    this.resumeAttempts += 1;
    // 1s, 2s, 4s, then the 8s cap — long enough to ride out a mobile hand-off.
    const delay = Math.min(1000 * 2 ** (this.resumeAttempts - 1), 8_000);
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      if (!this.sendingFlag) return;
      this.liveFlag = false;
      this.resume();
    }, delay);
  }

  /**
   * Re-attach is exhausted: stop pretending we can stream. The turn's content
   * still lands in history — the WS completion push (or the next open of this
   * session) refetches it.
   */
  private finishTurnWithoutStream(): void {
    this.activeTurns = 0;
    this.sendingFlag = false;
    this.thinkingFlag = false;
    this.retryStatusValue = null;
    this.notify();
    this.notifyTurnComplete();
    this.scheduleGc();
  }

  private scheduleGc(): void {
    if (this.gcTimer) clearTimeout(this.gcTimer);
    if (this.listeners.size > 0 || this.isBusy()) return;
    this.gcTimer = setTimeout(() => {
      this.gcTimer = null;
      if (this.listeners.size > 0 || this.isBusy()) return;
      chatStreamStore.drop(this.sessionId, this);
    }, SETTLED_RETENTION_MS);
  }

  // ── Bubble plumbing ──

  private setMessages(next: Message[]): void {
    this.messages = next;
    this.messagesChanged();
    this.notify();
  }

  /**
   * Merge messages into the streaming list. Mirrors the old ChatView handler:
   * a new user message clears the previous turn's bubbles (steer keeps them),
   * same-id updates replace in place, and pending cards are pinned last.
   */
  private applyMessages(msgs: Message[], clearPrevious = true): void {
    if (msgs.length === 0) return;
    this.touchActivity();

    const hasNewUser = msgs.some((m) => m.role === 'user');
    const shouldClear = clearPrevious !== false;
    const base =
      hasNewUser && shouldClear ? this.messages.filter((m) => isStreamOnlyCard(m)) : this.messages;

    const existing = new Map(base.map((m) => [m.id, m]));
    for (const msg of msgs) {
      const old = existing.get(msg.id);
      // Preserve tool_calls from the old message if this update (e.g.
      // text_delta) doesn't carry them — keeps tool cards in place.
      if (old?.tool_calls && !msg.tool_calls) {
        msg.tool_calls = old.tool_calls;
      }
      existing.set(msg.id, msg);
    }
    const merged = Array.from(existing.values()).sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    // Pin pending approval / user-question cards to the END of the list: they
    // are a pause point waiting for input, so text streamed afterwards must
    // render ABOVE the card, not below it.
    const pinned = merged.filter((m) => isStreamOnlyCard(m));
    const next =
      pinned.length > 0 ? [...merged.filter((m) => !isStreamOnlyCard(m)), ...pinned] : merged;

    this.setMessages(next);
  }

  /** Start a fresh assistant bubble for this turn. */
  private beginTurn(): void {
    this.assistantId = uid();
    this.timeline.reset();
    this.assistantCreatedAt = new Date().toISOString();
    this.toolCalls = [];
    // NOTE: runningTools / approvalMessages are intentionally NOT cleared here.
    // beginTurn also runs for steer/follow-up turns, and clearing them would
    // drop tool_call_end / approval_resolved events that arrive afterwards.
    this.activeTurns += 1;
  }

  /** End the current turn. Returns true if this was the last active turn. */
  private endTurn(): boolean {
    this.activeTurns -= 1;
    if (this.activeTurns <= 0) {
      this.activeTurns = 0;
      return true;
    }
    return false;
  }

  /** Reset the accumulator before replaying a `resume` baseline. */
  private resetForReplay(): void {
    // Persisted history never lives in this list, and user echoes are client
    // side — the baseline replays only the assistant side of the turn, so
    // keep those and rebuild everything else from the log.
    this.setMessages(
      this.messages.filter((m) => m.role === 'user' || isStreamOnlyCard(m) || m.harnessImprovement),
    );
    this.activeTurns = 0;
    this.steerBubble = false;
    this.assistantId = '';
    this.timeline.reset();
    this.assistantCreatedAt = '';
    this.toolCalls = [];
    this.runningTools.clear();
  }

  private buildAssistantMessage(extra?: Partial<Message>): Message {
    return {
      id: this.assistantId,
      session_id: this.sessionId,
      role: 'assistant',
      content: this.timeline.cleaned,
      tool_calls: this.toolCalls.length > 0 ? [...this.toolCalls] : undefined,
      segments: [...this.timeline.segments],
      created_at: this.assistantCreatedAt,
      ...extra,
    };
  }

  /**
   * Flush pending text into the timeline, then publish the bubble. The flush is
   * what makes segment order independent of flush timing.
   */
  private emitAssistantUpdate(): void {
    this.timeline.flushText();
    this.applyMessages([this.buildAssistantMessage({ content: this.timeline.cleaned })]);
  }

  // ── Reducer ──

  /**
   * Fold one event. Live and replayed (`resume` baseline) events take exactly
   * the same path — replay is what makes a reconnect deterministic.
   */
  private handleEvent(event: SSEEvent): void {
    this.touchActivity();

    switch (event.type) {
      case 'resume': {
        // Opening frame of a re-attach: replace state from the compacted log.
        this.resetForReplay();
        const replayedEvents = event.events ?? [];
        this.replaying = true;
        try {
          for (const replayed of replayedEvents) {
            this.applyEvent(replayed);
          }
        } finally {
          this.replaying = false;
        }
        const live = event.live === true;
        this.sendingFlag = live;
        this.liveFlag = live;
        if (!live) {
          this.thinkingFlag = false;
          this.retryStatusValue = null;
        }
        this.notify();
        // The reducer's own turn-complete notification is suppressed while
        // replaying, so a finished baseline asks for the history refetch here
        // exactly once (that is what prunes the replayed bubble afterwards).
        if (!live) this.notifyTurnComplete();
        break;
      }

      case 'idle':
      case 'resume_unavailable': {
        // Nothing to recover on the server: stop pretending we are streaming.
        this.activeTurns = 0;
        this.sendingFlag = false;
        this.thinkingFlag = false;
        this.retryStatusValue = null;
        this.liveFlag = false;
        this.notify();
        this.scheduleGc();
        break;
      }

      default:
        this.applyEvent(event);
        break;
    }
  }

  private applyEvent(event: SSEEvent): void {
    switch (event.type) {
      case 'turn_start':
        this.thinkingFlag = true;
        // Reuse the bubble eagerly created by beginSteerTurn.
        if (this.steerBubble) {
          this.steerBubble = false;
          this.activeTurns = 1;
        } else {
          this.beginTurn();
        }
        // turn_start publishes no bubble, and React reads the snapshot through
        // a revision cache — without this notification the flag stayed false
        // in the snapshot and the "thinking…" row never appeared (the first
        // text_delta that did notify had already cleared the flag again).
        this.notify();
        break;

      case 'skill_activated': {
        // Skill activation is a response — stop the "thinking" indicator.
        this.thinkingFlag = false;
        this.retryStatusValue = null;
        const skillName = event.data || '';
        if (skillName) {
          // beginFragment flushes the text streamed before the skill marker, so
          // the marker lands after it instead of erasing it.
          this.timeline.beginFragment({ type: 'skill', name: skillName });
          this.emitAssistantUpdate();
        } else {
          // No card to publish — still surface the cleared flag (see turn_start).
          this.notify();
        }
        break;
      }

      case 'text_delta': {
        this.timeline.appendText(event.data || '');
        // Cleared here, rendered by the throttled flush below — same 20fps
        // budget as the text itself.
        this.thinkingFlag = false;
        this.retryStatusValue = null;
        // Throttled flush: every update re-renders and re-parses the whole
        // markdown of the active bubble. The trailing timer guarantees the
        // final delta renders.
        this.emitAssistantUpdateThrottled();
        break;
      }

      case 'stream_retry': {
        this.thinkingFlag = false;
        this.retryStatusValue = this.describeRetry(event);
        this.notify();
        break;
      }

      case 'tool_call_start': {
        this.thinkingFlag = false;
        this.retryStatusValue = null;
        const tc: ToolCall = {
          id: event.toolCallId || uid(),
          name: event.toolName || 'unknown',
          // Malformed JSON args must not throw — an exception here would break
          // the reducer for the rest of the turn.
          arguments: (() => {
            try {
              return (typeof event.data === 'string' ? JSON.parse(event.data) : event.data) || {};
            } catch {
              return { _raw: event.data };
            }
          })(),
          status: 'running',
        };
        this.runningTools.set(tc.id, tc);
        this.toolCalls.push(tc);
        // Closes the text run first: everything streamed before this call keeps
        // its own segment above the card (also on a replayed baseline, where no
        // throttled flush ever ran).
        this.timeline.beginFragment({ type: 'tool_call', toolCall: tc });
        this.emitAssistantUpdate();
        break;
      }

      case 'tool_call_end': {
        const toolCallId = event.toolCallId;
        const existing = toolCallId ? this.runningTools.get(toolCallId) : undefined;
        if (existing && toolCallId) {
          existing.status = event.isError ? 'error' : 'success';
          existing.output = event.data ?? '';
          this.runningTools.delete(toolCallId);
        }
        if (existing && toolCallId) {
          const index = this.timeline.indexOfToolCall(toolCallId);
          if (index >= 0) {
            // A clone forces the card to re-render with its final status.
            this.timeline.updateToolCall(index, { ...existing });
            // Immediately extract media from webui_send_media / computer_use
            // (send_screenshot) output for inline display.
            if (
              (existing.name === 'webui_send_media' || existing.name === 'computer_use') &&
              existing.status === 'success' &&
              existing.output
            ) {
              const media = extractMediaSegment(existing.output);
              if (media) this.timeline.insertAfter(index, media);
            }
          }
        }
        this.emitAssistantUpdate();
        break;
      }

      case 'approval_required': {
        const approvalData: MessageApproval = {
          approvalId: event.approvalId || '',
          command: event.command || event.toolName || '',
          risk: event.risk || 'medium',
          reason: event.reason,
          status: 'pending',
        };
        const approvalMsg: Message = {
          id: `approval-${approvalData.approvalId}`,
          session_id: this.sessionId,
          role: 'assistant',
          content: '',
          approval: approvalData,
          created_at: new Date().toISOString(),
        };
        this.approvalMessages.set(approvalData.approvalId, approvalMsg);
        this.applyMessages([approvalMsg]);
        break;
      }

      case 'approval_resolved': {
        const aid = event.approvalId || '';
        const existing = this.approvalMessages.get(aid);
        if (existing && existing.approval) {
          const resolved: Message = {
            ...existing,
            approval: {
              ...existing.approval,
              status: (event.decision || '').startsWith('approve') ? 'approved' : 'rejected',
              decision: event.decision,
              timeoutReason: event.reason || existing.approval.timeoutReason,
            },
          };
          this.approvalMessages.set(aid, resolved);
          this.applyMessages([resolved]);
        }
        break;
      }

      case 'user_question': {
        const questionData: UserQuestion = {
          requestId: event.requestId || '',
          question: event.question || '',
          options: event.options || [],
          status: 'pending',
        };
        const questionMsg: Message = {
          id: `question-${questionData.requestId}`,
          session_id: this.sessionId,
          role: 'assistant',
          content: '',
          userQuestion: questionData,
          created_at: new Date().toISOString(),
        };
        this.questionMessages.set(questionData.requestId, questionMsg);
        this.applyMessages([questionMsg]);
        break;
      }

      case 'user_question_resolved': {
        const qid = event.requestId || '';
        const existing = this.questionMessages.get(qid);
        if (existing && existing.userQuestion) {
          const resolved: Message = {
            ...existing,
            userQuestion: {
              ...existing.userQuestion,
              status: 'answered',
              answer: event.answer,
            },
          };
          this.questionMessages.set(qid, resolved);
          this.applyMessages([resolved]);
        }
        break;
      }

      case 'harness_improvement': {
        if (!event.proposal) break;
        this.applyMessages([
          {
            id: `harness-${event.proposal.id}`,
            session_id: this.sessionId,
            role: 'assistant',
            content: '',
            harnessImprovement: event.proposal,
            created_at: new Date().toISOString(),
          },
        ]);
        break;
      }

      case 'thinking':
        // Reasoning content is deliberately suppressed in the WebUI.
        this.touchActivity();
        break;

      case 'done': {
        this.finishTurn(event);
        break;
      }

      case 'error': {
        this.failTurn(event);
        break;
      }

      default:
        break;
    }
  }

  private emitAssistantUpdateThrottled(): void {
    if (this.deltaTimer) return;
    this.deltaTimer = setTimeout(() => {
      this.deltaTimer = null;
      this.emitAssistantUpdate();
    }, DELTA_FLUSH_INTERVAL_MS);
  }

  private describeRetry(event: SSEEvent): string | null {
    try {
      const info = (typeof event.data === 'string' ? JSON.parse(event.data) : event.data) as
        | {
            scope?: string;
            failedModel?: string;
            model?: string;
            attempt?: number;
            maxRetries?: number;
          }
        | null
        | undefined;
      if (!info || typeof info !== 'object') return null;
      const failed = info.failedModel || '';
      if (info.scope === 'fallback') {
        return tr('chat.streamRetryFallback', { failed, model: info.model || '' });
      }
      return tr('chat.streamRetryRetry', {
        failed,
        attempt: info.attempt ?? 1,
        max: (info.maxRetries ?? 0) + 1,
      });
    } catch {
      return null;
    }
  }

  private finishTurn(event: SSEEvent): void {
    if (this.deltaTimer) {
      clearTimeout(this.deltaTimer);
      this.deltaTimer = null;
    }
    // The throttled flush was just cancelled — fold the trailing text in now,
    // or the bubble would end one chunk short (segments render, content is
    // only the fallback for text-only bubbles).
    this.timeline.flushText();
    this.retryStatusValue = null;
    const footer = event.footer as MessageFooter | undefined;

    const images: MessageImage[] = [];
    const imgRegex = /!\[([^\[\]]*)\]\(([^)\s]+)\)/g;
    const extractImages = (text: string) => {
      imgRegex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = imgRegex.exec(text)) !== null) {
        // Only locally-served chat media renders as images — arbitrary external
        // URLs (e.g. from web_search snippets) must not flood the chat.
        if (isChatMediaUrl(match[2])) {
          images.push({ alt: match[1] || undefined, url: match[2] });
        }
      }
    };
    const finalText = this.timeline.cleaned;
    extractImages(finalText);
    for (const tc of this.toolCalls) {
      // Only media-emitting tools may surface images in chat.
      if (tc.status === 'success' && tc.output && CHAT_MEDIA_TOOL_NAMES.has(tc.name)) {
        extractImages(tc.output);
      }
    }

    const files: MessageFile[] = [];
    const seenFiles = new Set<string>();
    // [^\[\]]+ avoids a greedy match from JSON array brackets in tool output.
    const linkRegex =
      /\[([^\[\]]+)\]\((\/(?:api\/files\/(?:serve|download)\?[^)\s]+|dl\/[^)\s]+|desktop-bridge-download\?[^)\s]+))\)/g;
    let linkMatch: RegExpExecArray | null;
    while ((linkMatch = linkRegex.exec(finalText)) !== null) {
      const label = linkMatch[1].trim();
      const url = linkMatch[2];
      if (!seenFiles.has(url)) {
        seenFiles.add(url);
        files.push({ name: label, path: url });
      }
    }
    for (const tc of this.toolCalls) {
      if (tc.status === 'success' && tc.output) {
        linkRegex.lastIndex = 0;
        while ((linkMatch = linkRegex.exec(tc.output)) !== null) {
          const url = linkMatch[2];
          if (!seenFiles.has(url)) {
            seenFiles.add(url);
            files.push({ name: linkMatch[1].trim(), path: url });
          }
        }
      }
    }

    // Deduplicate: remove images/files already shown as inline media segments.
    const mediaUrls = new Set<string>();
    for (const seg of this.timeline.segments) {
      if (seg.type === 'media' && seg.media?.url) mediaUrls.add(seg.media.url);
    }
    const dedupedImages = mediaUrls.size > 0 ? images.filter((i) => !mediaUrls.has(i.url)) : images;
    const dedupedFiles = mediaUrls.size > 0 ? files.filter((f) => !mediaUrls.has(f.path)) : files;

    this.applyMessages([
      this.buildAssistantMessage({
        content: finalText,
        footer: footer || undefined,
        images: dedupedImages.length > 0 ? dedupedImages : undefined,
        files: dedupedFiles.length > 0 ? dedupedFiles : undefined,
        // Keep the original creation time so this bubble stays in its correct
        // chronological position relative to user messages.
        created_at: this.assistantCreatedAt || new Date().toISOString(),
      }),
    ]);

    // The server persisted this turn's content BEFORE dispatching done, so the
    // bubble can be pruned once the refetch returns the persisted copy.
    if (this.assistantId) this.completedBubbles.add(this.assistantId);

    if (this.endTurn()) {
      this.sendingFlag = false;
      this.thinkingFlag = false;
      this.liveFlag = false;
      // A settled turn replayed from a live baseline is history for this
      // connection, not its end: the reopen handler decides what follows.
      if (!this.replaying) {
        this.abortTransport();
        this.notify();
        this.notifyTurnComplete();
        this.scheduleGc();
      }
    } else {
      this.notify();
    }
  }

  private failTurn(event: SSEEvent): void {
    if (this.deltaTimer) {
      clearTimeout(this.deltaTimer);
      this.deltaTimer = null;
    }
    this.timeline.flushText();
    this.retryStatusValue = null;
    this.activeTurns = 0;
    this.sendingFlag = false;
    this.thinkingFlag = false;
    this.liveFlag = false;
    if (!this.replaying) this.abortTransport();

    const errorText = event.error || '';
    // Deliberately NOT marking this bubble as persisted: the EventBridge error
    // path persists first, but the route-level catch path sends 'error'
    // WITHOUT persisting. The fuzzy match in pruneAfterRefetch covers the
    // persisted case instead.
    // User-initiated stops arrive as "Aborted" — expected, not worth stamping.
    if (errorText && errorText !== 'Aborted' && this.assistantCreatedAt) {
      this.applyMessages([
        {
          id: this.assistantId,
          session_id: this.sessionId,
          role: 'assistant',
          content: this.timeline.cleaned,
          tool_calls: this.toolCalls.length > 0 ? [...this.toolCalls] : undefined,
          segments: [...this.timeline.segments],
          error: errorText,
          created_at: this.assistantCreatedAt || new Date().toISOString(),
        },
      ]);
    }
    this.notify();
    if (!this.replaying) {
      this.notifyTurnComplete();
      this.scheduleGc();
    }
  }
}

/** Pull an inline media segment out of a tool output's markdown link. */
function extractMediaSegment(output: string): MessageSegment | null {
  // Match both /api/files/serve?path=... and /dl/<token>/<filename> URLs.
  // [^\[\]] (exclude both brackets) instead of [^\]] prevents a greedy match
  // from JSON array brackets like [{...}] in the output.
  const imgMatch = output.match(
    /!\[([^\[\]]*)\]\((\/(?:api\/files\/serve\?path=[^)\s]+|dl\/[^)\s]+|desktop-bridge-download\?[^)\s]+))\)/,
  );
  const linkMatch =
    !imgMatch &&
    output.match(
      /\[([^\[\]]+)\]\((\/(?:api\/files\/serve\?path=[^)\s]+|dl\/[^)\s]+|desktop-bridge-download\?[^)\s]+))\)/,
    );
  const match = imgMatch || linkMatch;
  if (!match) return null;
  const alt = match[1] || '';
  const serveUrl = match[2];
  const fileName = (() => {
    try {
      if (serveUrl.startsWith('/dl/')) {
        return decodeURIComponent(serveUrl.split('/').pop() || alt);
      }
      const params = new URLSearchParams(new URL(serveUrl, window.location.origin).search);
      return (
        decodeURIComponent(params.get('path') || '')
          .split('/')
          .pop() || alt
      );
    } catch {
      return alt;
    }
  })();
  const isImage = !!imgMatch;
  const isVideo = /\.(mp4|webm|mov|avi|mkv)$/i.test(fileName);
  return {
    type: 'media',
    media: {
      url: serveUrl,
      alt: alt || fileName,
      name: fileName,
      type: isVideo ? 'video' : isImage ? 'image' : 'file',
    },
  };
}

/**
 * Translation for module-level code (the store cannot use React hooks).
 * The i18n instance is initialised by main.tsx before any stream can start.
 */
function tr(key: string, options: Record<string, unknown>): string {
  try {
    return String(i18n.t(`common:${key}`, options));
  } catch {
    return '';
  }
}

/**
 * Singleton registry of per-session stream state.
 *
 * Registered on the module (not in React context) on purpose: the streams must
 * outlive route changes, including leaving the chat screen entirely.
 */
class ChatStreamStore {
  private sessions = new Map<string, SessionStream>();
  private aliveTimer: ReturnType<typeof setInterval> | null = null;
  private visibilityBound = false;

  private stream(sessionId: string, projectId: string): SessionStream {
    let stream = this.sessions.get(sessionId);
    if (!stream) {
      stream = new SessionStream(sessionId, projectId);
      this.sessions.set(sessionId, stream);
    } else if (projectId) {
      stream.projectId = projectId;
    }
    return stream;
  }

  /** Read-only access that never creates state (React render path). */
  peek(sessionId?: string): SessionStream | undefined {
    return sessionId ? this.sessions.get(sessionId) : undefined;
  }

  snapshot(sessionId?: string): ChatStreamSnapshot {
    if (!sessionId) return EMPTY_SNAPSHOT;
    return this.sessions.get(sessionId)?.getSnapshot() ?? EMPTY_SNAPSHOT;
  }

  isSending(sessionId?: string): boolean {
    if (!sessionId) return false;
    return this.sessions.get(sessionId)?.isSending() ?? false;
  }

  subscribe(sessionId: string, listener: () => void): () => void {
    const stream = this.stream(sessionId, '');
    return stream.subscribe(listener);
  }

  subscribeTurnComplete(sessionId: string, listener: () => void): () => void {
    return this.stream(sessionId, '').onTurnComplete(listener);
  }

  /** Start a turn from the chat input. */
  send(sessionId: string, projectId: string, params: SendTurnParams): void {
    this.stream(sessionId, projectId).send(params);
    this.ensureAliveWatcher();
  }

  /** Local echo for messages that arrive outside the SSE stream (steer). */
  echo(sessionId: string, projectId: string, messages: Message[], clearPrevious = false): void {
    this.stream(sessionId, projectId).echo(messages, clearPrevious);
  }

  beginSteerTurn(sessionId: string, projectId: string): void {
    this.stream(sessionId, projectId).beginSteerTurn();
    this.ensureAliveWatcher();
  }

  /**
   * Ask the server whether this session still has a LIVE turn and attach to it
   * if so. Called when a session is opened, and again when the page wakes up
   * (visibility, bfcache restore, network regained) — the moments a reload, a
   * backgrounded phone, a suspended PWA or a turn started in another tab
   * become visible again.
   *
   * The probe is `liveOnly`, so a settled turn inside the hub's retention
   * window answers `idle` instead of being replayed over fetched history; that
   * is what makes repeated probing safe on mobile (where the app may never
   * reload). Throttled per session and skipped while this store already owns a
   * stream.
   */
  ensureAttached(sessionId: string, projectId: string): void {
    const stream = this.stream(sessionId, projectId);
    if (stream.isBusy()) return;
    if (stream.probeIsFresh()) return;
    stream.resume({ liveOnly: true });
    this.ensureAliveWatcher();
  }

  /**
   * The page woke up. Repair a stream that looks dead and, for the session the
   * user is looking at, re-probe for a turn that started while we were away.
   */
  handleWake(currentSessionId?: string, projectId?: string): void {
    if (currentSessionId && projectId) this.ensureAttached(currentSessionId, projectId);
    for (const stream of this.sessions.values()) stream.checkAlive(true);
  }

  /** The network came back: retry stalled streams immediately. */
  handleOnline(): void {
    for (const stream of this.sessions.values()) stream.retryNow();
  }

  pruneAfterRefetch(sessionId: string | undefined, fetched: Message[]): void {
    if (!sessionId) return;
    this.sessions.get(sessionId)?.pruneAfterRefetch(fetched);
  }

  /** Test/teardown seam. */
  drop(sessionId: string, expected?: SessionStream): void {
    const stream = this.sessions.get(sessionId);
    if (!stream) return;
    if (expected && stream !== expected) return;
    stream.dispose();
    this.sessions.delete(sessionId);
  }

  reset(): void {
    for (const sessionId of [...this.sessions.keys()]) this.drop(sessionId);
    if (this.aliveTimer) {
      clearInterval(this.aliveTimer);
      this.aliveTimer = null;
    }
  }

  /**
   * Wake-up / timeout watchdog shared by all sessions. Browsers throttle
   * timers in a background tab, so `visibilitychange` is the reliable trigger;
   * the interval only covers a tab that stays visible while its socket died.
   */
  private ensureAliveWatcher(): void {
    if (typeof document !== 'undefined' && !this.visibilityBound) {
      this.visibilityBound = true;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        for (const stream of this.sessions.values()) stream.checkAlive(true);
      });
      // bfcache restore (iOS/Android return to a suspended page) and a
      // regained network are both "the world changed" moments for a stream.
      window.addEventListener('pageshow', () => {
        for (const stream of this.sessions.values()) stream.checkAlive(true);
      });
      window.addEventListener('online', () => this.handleOnline());
    }
    if (this.aliveTimer) return;
    if (typeof setInterval === 'undefined') return;
    this.aliveTimer = setInterval(() => {
      if (this.sessions.size === 0) {
        if (this.aliveTimer) clearInterval(this.aliveTimer);
        this.aliveTimer = null;
        return;
      }
      for (const stream of this.sessions.values()) stream.checkAlive();
    }, 15_000);
  }
}

/** Module-level singleton — streams outlive every component. */
export const chatStreamStore = new ChatStreamStore();
