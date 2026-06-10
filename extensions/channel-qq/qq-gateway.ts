// ---------------------------------------------------------------------------
// QQ Bot API v2 WebSocket Gateway
//
// Manages the persistent connection to the QQ Bot gateway (api.sgroup.qq.com)
// with the following lifecycle:
//   Connect -> Hello (op 10) -> Identify (op 2) / Resume (op 6) -> Ready
//   -> Heartbeat (op 1) every heartbeat_interval ms
//   -> Dispatch events (op 0) forwarded to registered callback
//   -> Reconnect on disconnect with session resume
//   -> REST API wrapper for sending messages
// ---------------------------------------------------------------------------

import WebSocket from 'ws';
import type { Logger } from 'pino';
import type { QQAuth } from './qq-auth.js';
import type { QQWsPayload } from './qq-types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Bitmask: GROUP_AT_MESSAGE_CREATE (1<<25) | C2C_MESSAGE_CREATE (1<<30). */
const INTENTS = (1 << 25) | (1 << 30);

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const IDENTIFY_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_INTERVAL = 41_250;

// ---------------------------------------------------------------------------
// QQGateway
// ---------------------------------------------------------------------------

export type EventCallback = (payload: QQWsPayload) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Reply limit tracking
// ---------------------------------------------------------------------------

/**
 * Tracks per-user reply counts within a sliding time window.
 * Used to prevent spamming users with too many replies.
 */
export interface ReplyTracker {
  /** Record that a reply was sent to the given user. */
  recordMessageReply(openid: string): void;

  /**
   * Check whether the user is still within the reply limit.
   * Returns `true` if the user may receive another reply, `false` if the
   * limit has been exceeded.
   */
  checkMessageReplyLimit(openid: string): boolean;

  /** Get current reply stats (count + window start) for the user. */
  getReplyStats(openid: string): { count: number; windowStart: number };
}

/**
 * Create a ReplyTracker with the given limits.
 *
 * @param maxReplies  Maximum replies allowed per time window (default: 5).
 * @param windowMs    Time window in milliseconds (default: 60 000 = 1 minute).
 */
export function createReplyTracker(
  maxReplies: number = 5,
  windowMs: number = 60_000,
): ReplyTracker {
  const timestamps = new Map<string, number[]>();

  /** Prune entries outside the current window for a given user. */
  function prune(openid: string): void {
    const now = Date.now();
    const existing = timestamps.get(openid);
    if (!existing) return;
    const filtered = existing.filter((t) => now - t < windowMs);
    if (filtered.length === 0) {
      timestamps.delete(openid);
    } else {
      timestamps.set(openid, filtered);
    }
  }

  return {
    recordMessageReply(openid: string): void {
      prune(openid);
      const existing = timestamps.get(openid) ?? [];
      existing.push(Date.now());
      timestamps.set(openid, existing);
    },

    checkMessageReplyLimit(openid: string): boolean {
      prune(openid);
      const existing = timestamps.get(openid);
      return (existing?.length ?? 0) < maxReplies;
    },

    getReplyStats(openid: string): { count: number; windowStart: number } {
      prune(openid);
      const existing = timestamps.get(openid);
      return {
        count: existing?.length ?? 0,
        windowStart: Date.now() - windowMs,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// QQGateway
// ---------------------------------------------------------------------------

export class QQGateway {
  private ws: WebSocket | null = null;
  private auth: QQAuth;
  private logger: Logger;

  // Session state
  private sessionId: string | null = null;
  private lastSeq: number | null = null;
  private _connected = false;

  // Heartbeat
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatInterval: number = DEFAULT_HEARTBEAT_INTERVAL;

  // Reconnect
  private intentionalClose = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay: number = RECONNECT_BASE_DELAY_MS;

  // Handshake promise
  private handshakeResolve: (() => void) | null = null;
  private handshakeReject: ((err: Error) => void) | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;

  // Event callback
  private eventCallback: EventCallback | null = null;

  // Approval interaction handler (injected after construction)
  private approvalHandler: ((event: any) => Promise<void>) | null = null;

  /** Inject a handler for INTERACTION_CREATE (approval button) events. */
  setApprovalHandler(handler: (event: any) => Promise<void>): void {
    this.approvalHandler = handler;
  }

  constructor(auth: QQAuth, logger: Logger) {
    this.auth = auth;
    this.logger = logger.child({ module: 'qq-gateway' });
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Whether the gateway currently has an active session. */
  get connected(): boolean {
    return this._connected;
  }

  /** Get a valid access token for QQ Bot API v2 media downloads. */
  async getAccessToken(): Promise<string> {
    return this.auth.getAccessToken();
  }

  /**
   * Open a WebSocket connection to the QQ gateway.
   * Resolves once the READY (or RESUMED) event is received.
   */
  async connect(): Promise<void> {
    if (this._connected) return;
    this.intentionalClose = false;

    const gatewayUrl = await this.auth.getGatewayUrl();
    const token = await this.auth.getAccessToken();

    return new Promise<void>((resolve, reject) => {
      this.handshakeResolve = resolve;
      this.handshakeReject = reject;
      try {
        this.createConnection(gatewayUrl, token);
      } catch (err) {
        this.handshakeResolve = null;
        this.handshakeReject = null;
        reject(err);
      }
    });
  }

  /**
   * Close the WebSocket connection gracefully.
   * Stops heartbeat and cancels pending reconnect.
   */
  async close(): Promise<void> {
    this.intentionalClose = true;
    this.cancelReconnect();
    this.clearHeartbeat();

    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close(1000, 'Client shutdown');
      } catch {
        // Best-effort close
      }
      this.ws = null;
    }

    this._connected = false;
    this.sessionId = null;
    this.lastSeq = null;
  }

  /**
   * Register a callback for dispatch events (op 0 with t field).
   * Fires for C2C_MESSAGE_CREATE, GROUP_AT_MESSAGE_CREATE, etc.
   */
  onEvent(callback: EventCallback): void {
    this.eventCallback = callback;
  }

  /**
   * Make an authenticated REST API call to the QQ Bot API.
   *
   * @param method  HTTP method (GET, POST, etc.)
   * @param path    API path, e.g. "/v2/groups/{group_openid}/messages"
   * @param body    Optional JSON request body
   */
  async sendRestApi(method: string, path: string, body?: unknown): Promise<any> {
    const token = await this.auth.getAccessToken();
    const baseUrl = this.auth.getApiBase();
    const url = `${baseUrl}${path}`;

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `QQBot ${token}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      let detail = '';
      try {
        const parsed = JSON.parse(text);
        detail = parsed.message || parsed.error || text;
      } catch {
        detail = text;
      }
      throw new Error(`QQ API ${method} ${path} failed (${response.status}): ${detail}`);
    }

    // 204 No Content for some endpoints
    if (response.status === 204) return undefined;
    return response.json();
  }

  // -----------------------------------------------------------------------
  // Connection lifecycle
  // -----------------------------------------------------------------------

  private createConnection(gatewayUrl: string, _token: string): void {
    const ws = new WebSocket(gatewayUrl);
    this.ws = ws;

    ws.on('open', () => {
      this.logger.info('QQ WebSocket connection established');
    });

    ws.on('message', (data: WebSocket.Data) => {
      this.handleMessage(data);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      this._connected = false;
      this.clearHeartbeat();
      this.ws = null;

      const reasonStr = reason?.toString() || 'unknown';
      this.logger.warn({ code, reason: reasonStr }, 'QQ WebSocket closed');

      // Reject handshake if still pending
      if (this.handshakeReject) {
        this.handshakeReject(
          new Error(`QQ WebSocket closed during connect: code=${code} reason=${reasonStr}`),
        );
        this.cleanupHandshake();
      }

      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    });

    ws.on('error', (err: Error) => {
      this.logger.error({ err: err.message }, 'QQ WebSocket error');

      // On error during initial connect, reject handshake
      if (this.handshakeReject) {
        this.handshakeReject(err);
        this.cleanupHandshake();
      }
    });
  }

  // -----------------------------------------------------------------------
  // Message handling
  // -----------------------------------------------------------------------

  private handleMessage(data: WebSocket.Data): void {
    let payload: QQWsPayload;
    try {
      payload = JSON.parse(data.toString()) as QQWsPayload;
    } catch {
      this.logger.warn({ raw: String(data).slice(0, 200) }, 'Failed to parse WebSocket message');
      return;
    }

    switch (payload.op) {
      case 10: // Hello
        this.handleHello(payload);
        break;

      case 0: // Dispatch (event)
        this.handleDispatch(payload);
        break;

      case 11: // Heartbeat ACK
        // Acknowledgement received — nothing to do
        break;

      case 7: // Reconnect
        this.logger.info('Received op 7 Reconnect — closing and reconnecting');
        this.intentionalClose = true;
        this.ws?.close();
        this.intentionalClose = false;
        this.scheduleReconnect(true /* immediate */);
        break;

      case 9: // Invalid Session
        this.logger.warn('Received op 9 Invalid Session — clearing session and re-identifying');
        this.sessionId = null;
        this.scheduleReconnect(true /* immediate */);
        break;

      default:
        this.logger.trace({ op: payload.op }, 'Unknown WebSocket op code');
        break;
    }
  }

  /** Handle Hello (op 10): start heartbeat, send Identify or Resume. */
  private async handleHello(payload: QQWsPayload): Promise<void> {
    const hello = payload.d as { heartbeat_interval: number } | undefined;
    this.heartbeatInterval = hello?.heartbeat_interval ?? DEFAULT_HEARTBEAT_INTERVAL;
    this.logger.debug({ heartbeatInterval: this.heartbeatInterval }, 'QQ Hello received');

    // Start the heartbeat loop
    this.startHeartbeat();

    // Resolve / Identify
    const token = await this.auth.getAccessToken();
    const authStr = `QQBot ${token}`;

    if (this.sessionId) {
      // Attempt session resume
      this.logger.info({ sessionId: this.sessionId }, 'Attempting session resume');
      this.sendWs({
        op: 6,
        d: {
          token: authStr,
          session_id: this.sessionId,
          seq: this.lastSeq ?? 0,
        } satisfies QQResume,
      });
    } else {
      // Fresh identify
      this.logger.info('Sending Identify (op 2)');
      this.sendWs({
        op: 2,
        d: {
          token: authStr,
          intents: INTENTS,
          shard: [0, 1],
        } satisfies QQIdentify,
      });
    }

    // Set timeout for the handshake
    this.handshakeTimer = setTimeout(() => {
      if (this.handshakeReject) {
        this.logger.error('QQ Identify / Resume timed out');
        this.handshakeReject(new Error('QQ handshake timed out'));
        this.cleanupHandshake();
        // Close so we can reconnect
        this.close().catch(() => {});
      }
    }, IDENTIFY_TIMEOUT_MS);
  }

  /** Handle Dispatch (op 0): track seq, emit to callback. */
  private handleDispatch(payload: QQWsPayload): void {
    // Track sequence number for heartbeats and resume
    if (payload.s != null) {
      this.lastSeq = payload.s;
    }

    if (payload.t === 'READY') {
      const ready = payload.d as QQReady;
      this.sessionId = ready.session_id;
      this._connected = true;
      this.reconnectDelay = RECONNECT_BASE_DELAY_MS;
      this.logger.info({ userId: ready.user.id, sessionId: ready.session_id }, 'QQ Ready received');

      // Resolve handshake promise
      if (this.handshakeResolve) {
        this.handshakeResolve();
        this.cleanupHandshake();
      }
      return;
    }

    if (payload.t === 'RESUMED') {
      this._connected = true;
      this.reconnectDelay = RECONNECT_BASE_DELAY_MS;
      this.logger.info('QQ session resumed');

      if (this.handshakeResolve) {
        this.handshakeResolve();
        this.cleanupHandshake();
      }
      return;
    }

    // INTERACTION_CREATE → route to approval handler if set
    if (payload.t === 'INTERACTION_CREATE') {
      if (this.approvalHandler) {
        this.approvalHandler(payload.d).catch((err) => {
          this.logger.error({ err, eventType: 'INTERACTION_CREATE' }, 'QQ approval handler error');
        });
      }
      return;
    }

    // Forward all other dispatch events to the registered callback
    if (this.eventCallback) {
      try {
        const result = this.eventCallback(payload);
        if (result instanceof Promise) {
          result.catch((err) => {
            this.logger.error({ err, eventType: payload.t }, 'QQ event handler error');
          });
        }
      } catch (err) {
        this.logger.error({ err, eventType: payload.t }, 'QQ event handler error');
      }
    }
  }

  // -----------------------------------------------------------------------
  // Heartbeat
  // -----------------------------------------------------------------------

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.clearHeartbeat();
        return;
      }
      this.sendWs({ op: 1, d: this.lastSeq ?? null });
    }, this.heartbeatInterval);
    // Prevent the timer from keeping the process alive
    if (this.heartbeatTimer && typeof this.heartbeatTimer === 'object' && 'unref' in this.heartbeatTimer) {
      (this.heartbeatTimer as NodeJS.Timeout).unref();
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // -----------------------------------------------------------------------
  // Reconnection
  // -----------------------------------------------------------------------

  private scheduleReconnect(immediate?: boolean): void {
    if (this.intentionalClose) return;

    this.cancelReconnect();

    const delay = immediate ? 0 : this.reconnectDelay;
    this.logger.info({ delayMs: delay }, 'Scheduling QQ gateway reconnect');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.logger.info('Attempting QQ gateway reconnect...');
      this.connect().catch((err) => {
        this.logger.error({ err: (err as Error).message }, 'QQ gateway reconnect failed');
      });
    }, delay);

    // Exponential backoff with ceiling (only for non-immediate)
    if (!immediate) {
      this.reconnectDelay = Math.min(
        this.reconnectDelay * 2,
        RECONNECT_MAX_DELAY_MS,
      );
    }
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /** Send a JSON payload over the WebSocket. */
  private sendWs(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn('Cannot send — WebSocket not open');
      return;
    }
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (err) {
      this.logger.error({ err: (err as Error).message }, 'Failed to send WebSocket message');
    }
  }

  private cleanupHandshake(): void {
    this.handshakeResolve = null;
    this.handshakeReject = null;
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }
}

// Forward-declared interfaces for Identify / Resume
interface QQIdentify {
  token: string;
  intents: number;
  shard: [number, number];
}

interface QQResume {
  token: string;
  session_id: string;
  seq: number;
}

interface QQReady {
  version: number;
  session_id: string;
  user: { id: string };
  shard: [number, number];
}
