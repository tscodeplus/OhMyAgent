/**
 * In-flight WebUI chat stream hub — reconnect baseline + live fan-out.
 *
 * A turn does not belong to the HTTP request that started it: the agent keeps
 * running when the browser tab is closed, backgrounded, reloaded, or the user
 * switches to another conversation. Without a hub, a returning client has only
 * two options — show a "thinking" placeholder and wait for the persisted
 * history, or start over — and the partial text, tool cards and pending
 * approval cards streamed so far are simply lost.
 *
 * The hub owns one process-local record per live session turn and folds every
 * published SSE event into a **compacted baseline** (consecutive text deltas
 * merge into one event; reasoning deltas are dropped because the WebUI
 * suppresses them). A re-attaching client gets that baseline first, numbered
 * with a monotone `index`, and then the live tail — the same reconnect shape
 * deepseek-harness uses for its assistant streams: replace from a compact
 * baseline, continue densely, never restart the turn.
 *
 * The log is bounded: once a turn's baseline exceeds {@link MAX_BASELINE_BYTES}
 * it stops buffering and reports `resume_unavailable`, so a runaway turn
 * cannot pin process memory. The client then falls back to the pre-existing
 * behaviour (thinking indicator + history refetch when the turn completes).
 *
 * Everything here is process-local and in-memory. A gateway restart loses the
 * baselines — the persisted history (and the `agent_turn_complete` WebSocket
 * push) remains the durable source of truth.
 */

/** One SSE event as published by the chat route / reply dispatcher. */
export interface ChatStreamEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * One live subscriber. `write` receives the event as it is published;
 * `buffered` reports unsent bytes queued on the transport (a backgrounded tab
 * on a slow link must not pin an ever-growing buffer), and `close` lets the
 * hub release a transport it stopped feeding.
 */
export interface ChatStreamSubscriber {
  write: (event: ChatStreamEvent) => void;
  buffered?: () => number;
  close?: () => void;
}

/** Result of {@link ChatStreamHub.subscribe}. */
export type ChatStreamAttachStatus = 'attached' | 'idle' | 'unavailable';

/** Options for {@link ChatStreamHub.attach}. */
export interface ChatStreamAttachOptions {
  /**
   * Answer `idle` for a turn that already settled (still inside the retention
   * window) instead of replaying it. Used by cheap re-probes — a resume on
   * wake-up, a PWA relaunch, a session re-open — where replaying a completed
   * reply would only duplicate bubbles the history fetch already has.
   */
  liveOnly?: boolean;
}

export interface ChatStreamAttachHandle {
  status: ChatStreamAttachStatus;
  /**
   * True when the baseline already contained the terminal event (the turn had
   * finished inside the retention window). Nothing follows: the caller can
   * close the transport immediately.
   */
  finished: boolean;
  /** Stop receiving events. Idempotent. */
  detach: () => void;
}

/**
 * Per-turn ceiling on the buffered baseline. A merged text run is the only
 * part that grows without bound; 2 MiB of assistant text in a single
 * unfinished turn is far beyond anything a real reply produces, so exceeding
 * it means the turn is pathological — serve `unavailable` instead of memory.
 */
export const MAX_BASELINE_BYTES = 2 * 1024 * 1024;

/** Unsent-byte ceiling per subscriber before it is dropped (client re-attaches). */
export const MAX_SUBSCRIBER_BUFFER_BYTES = 4 * 1024 * 1024;

/**
 * How long a finished turn's baseline stays replayable. A client that reloads
 * just as the turn ends still gets the complete tail (`live: false`) instead
 * of an `idle` answer, so its bubble does not blink out before the history
 * refetch lands.
 */
export const FINISHED_RETENTION_MS = 120_000;

/** Event types that end a turn. */
const TERMINAL_TYPES = new Set(['done', 'error']);

/** Delta types folded into a single accumulated event instead of one per token. */
const MERGED_DELTA_TYPES = new Set(['text_delta']);

/** Delta types never buffered for replay (suppressed in the WebUI anyway). */
const DROPPED_DELTA_TYPES = new Set(['thinking']);

interface SubscriberEntry {
  subscriber: ChatStreamSubscriber;
}

interface TurnState {
  /** Identity of this turn's stream — changes on every new turn. */
  streamId: string;
  sessionId: string;
  startedAt: number;
  /** Number of events published so far (the baseline's newest index). */
  index: number;
  /** Compacted event log replaying the turn from its start. */
  events: ChatStreamEvent[];
  /** Approximate serialized size of {@link events}. */
  bytes: number;
  /** Set once the baseline outgrew {@link MAX_BASELINE_BYTES}. */
  overflowed: boolean;
  /** False after a terminal event. */
  live: boolean;
  subscribers: Set<SubscriberEntry>;
  expireTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Ownership handle for the request that started a turn. Publishing through it
 * feeds the baseline and every attached subscriber (including that request's
 * own SSE writer).
 */
export interface ChatStreamTurn {
  readonly streamId: string;
  /** Publish one event: fan out live, fold into the reconnect baseline. */
  publish: (event: ChatStreamEvent) => void;
  /**
   * Register a subscriber (the originating POST's SSE writer, or a
   * re-attaching follower). Returns its detach function.
   */
  subscribe: (subscriber: ChatStreamSubscriber) => () => void;
}

/**
 * Process-local registry of in-flight turns, keyed by session id.
 *
 * One turn per session: the agent serializes turns for a session, so a new
 * turn supersedes whatever record was there (a superseded record's subscribers
 * are closed rather than served stale content).
 */
export class ChatStreamHub {
  private readonly turns = new Map<string, TurnState>();
  private readonly maxBaselineBytes: number;
  private readonly maxSubscriberBufferBytes: number;
  private readonly finishedRetentionMs: number;
  private readonly logger?: { warn: (...args: unknown[]) => void };

  constructor(
    opts: {
      maxBaselineBytes?: number;
      maxSubscriberBufferBytes?: number;
      finishedRetentionMs?: number;
      logger?: { warn: (...args: unknown[]) => void };
    } = {},
  ) {
    this.maxBaselineBytes = opts.maxBaselineBytes ?? MAX_BASELINE_BYTES;
    this.maxSubscriberBufferBytes = opts.maxSubscriberBufferBytes ?? MAX_SUBSCRIBER_BUFFER_BYTES;
    this.finishedRetentionMs = opts.finishedRetentionMs ?? FINISHED_RETENTION_MS;
    this.logger = opts.logger;
  }

  /**
   * Open a turn for a session, replacing (and closing) any previous record.
   * The returned handle publishes every event of the turn.
   */
  begin(sessionId: string): ChatStreamTurn {
    const previous = this.turns.get(sessionId);
    if (previous) {
      // Two turns for one session cannot both be true. The old subscribers
      // are cut loose instead of being served a half-life: their client
      // re-attaches and lands on the new record.
      this.drop(previous);
    }

    const state: TurnState = {
      streamId: `${sessionId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      startedAt: Date.now(),
      index: 0,
      events: [],
      bytes: 0,
      overflowed: false,
      live: true,
      subscribers: new Set(),
    };
    this.turns.set(sessionId, state);

    return {
      streamId: state.streamId,
      publish: (event) => this.publish(state, event),
      subscribe: (subscriber) => this.addSubscriber(state, subscriber),
    };
  }

  /**
   * Attach a client to whatever turn is live (or freshly finished) for a
   * session. Writes the opening frame through `subscriber.write` synchronously,
   * then registers the subscriber so no event can slip in between.
   */
  attach(
    sessionId: string,
    subscriber: ChatStreamSubscriber,
    opts: ChatStreamAttachOptions = {},
  ): ChatStreamAttachHandle {
    const state = this.turns.get(sessionId);
    if (!state) {
      subscriber.write({ type: 'idle' });
      return { status: 'idle', finished: true, detach: () => {} };
    }
    if (state.overflowed) {
      subscriber.write({ type: 'resume_unavailable', streamId: state.streamId });
      return { status: 'unavailable', finished: true, detach: () => {} };
    }
    // A finished turn inside the retention window is only interesting to a
    // client that lost the tail mid-turn. Probing browsers (mobile resume,
    // session re-open) ask for live turns only, so they can poll cheaply
    // without resurrecting a completed reply on top of fetched history.
    if (!state.live && opts.liveOnly) {
      subscriber.write({ type: 'idle' });
      return { status: 'idle', finished: true, detach: () => {} };
    }

    // Opening frame = compact baseline. `events` replay the turn from its
    // start, so the client rebuilds the exact bubble state it lost.
    subscriber.write({
      type: 'resume',
      streamId: state.streamId,
      index: state.index,
      live: state.live,
      startedAt: state.startedAt,
      events: state.events,
    });
    if (!state.live) {
      // Fully replayed — the tail already contains the terminal event, so the
      // client has everything and can close its connection.
      return { status: 'attached', finished: true, detach: () => {} };
    }
    const detach = this.addSubscriber(state, subscriber);
    return { status: 'attached', finished: false, detach };
  }

  /** Snapshot used by tests and diagnostics. */
  peek(
    sessionId: string,
  ): { streamId: string; index: number; live: boolean; events: ChatStreamEvent[] } | undefined {
    const state = this.turns.get(sessionId);
    if (!state) return undefined;
    return {
      streamId: state.streamId,
      index: state.index,
      live: state.live,
      events: state.events,
    };
  }

  /** Number of retained turns (tests + shutdown assertions). */
  get size(): number {
    return this.turns.size;
  }

  /** Drop every retained turn and its timers. */
  dispose(): void {
    for (const state of [...this.turns.values()]) {
      this.drop(state);
    }
  }

  private publish(state: TurnState, event: ChatStreamEvent): void {
    if (!state.live) return;
    state.index += 1;

    this.fold(state, event);

    const frame: ChatStreamEvent = { ...event, index: state.index };
    for (const entry of [...state.subscribers]) {
      this.writeToSubscriber(entry.subscriber, frame, state);
    }

    if (TERMINAL_TYPES.has(event.type)) {
      state.live = false;
      // The terminal event was just written to every subscriber — release the
      // transports now so a re-attached follower does not linger on pings.
      for (const entry of [...state.subscribers]) {
        try {
          entry.subscriber.close?.();
        } catch {
          /* transport already gone */
        }
      }
      state.subscribers.clear();
      // Keep the tail replayable briefly, then release it.
      state.expireTimer = setTimeout(() => {
        if (this.turns.get(state.sessionId) === state) {
          this.turns.delete(state.sessionId);
        }
      }, this.finishedRetentionMs);
      state.expireTimer.unref?.();
    }
  }

  /** Fold one event into the reconnect baseline, compacting where possible. */
  private fold(state: TurnState, event: ChatStreamEvent): void {
    if (state.overflowed) return;
    if (DROPPED_DELTA_TYPES.has(event.type)) return;

    const last = state.events[state.events.length - 1];
    if (
      MERGED_DELTA_TYPES.has(event.type) &&
      last?.type === event.type &&
      typeof last.data === 'string' &&
      typeof event.data === 'string'
    ) {
      // Consecutive deltas are one growing string — one event, not thousands.
      last.data += event.data;
      state.bytes += event.data.length;
    } else {
      // Store our own copy: the publisher may reuse/mutate its event object.
      state.events.push({ ...event });
      state.bytes += 32 + (typeof event.data === 'string' ? event.data.length : 0);
    }

    if (state.bytes > this.maxBaselineBytes) {
      this.logger?.warn?.(
        { streamId: state.streamId, sessionId: state.sessionId, bytes: state.bytes },
        '[chat-stream-hub] turn baseline exceeded the cap — resume unavailable for this turn',
      );
      state.overflowed = true;
      state.events = [];
      state.bytes = 0;
    }
  }

  private addSubscriber(state: TurnState, subscriber: ChatStreamSubscriber): () => void {
    const entry: SubscriberEntry = { subscriber };
    state.subscribers.add(entry);
    return () => {
      state.subscribers.delete(entry);
    };
  }

  private writeToSubscriber(
    subscriber: ChatStreamSubscriber,
    frame: ChatStreamEvent,
    state: TurnState,
  ): void {
    // A backgrounded tab on a slow link would otherwise pin an ever-growing
    // write buffer for the life of the process. Dropping it is recoverable:
    // the client re-attaches and receives the baseline instead.
    const buffered = subscriber.buffered?.() ?? 0;
    if (buffered > this.maxSubscriberBufferBytes) {
      state.subscribers.forEach((entry) => {
        if (entry.subscriber === subscriber) state.subscribers.delete(entry);
      });
      this.logger?.warn?.(
        { streamId: state.streamId, sessionId: state.sessionId, buffered },
        '[chat-stream-hub] dropping slow subscriber — it will re-attach from the baseline',
      );
      try {
        subscriber.close?.();
      } catch {
        /* transport already gone */
      }
      return;
    }
    try {
      subscriber.write(frame);
    } catch {
      // Transport closed — release the subscription.
      state.subscribers.forEach((entry) => {
        if (entry.subscriber === subscriber) state.subscribers.delete(entry);
      });
    }
  }

  private drop(state: TurnState): void {
    if (state.expireTimer) clearTimeout(state.expireTimer);
    for (const entry of [...state.subscribers]) {
      try {
        entry.subscriber.close?.();
      } catch {
        /* transport already gone */
      }
    }
    state.subscribers.clear();
    if (this.turns.get(state.sessionId) === state) {
      this.turns.delete(state.sessionId);
    }
  }
}
