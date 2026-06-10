// ---------------------------------------------------------------------------
// DesktopBridgeRegistry — manages WebSocket connections from desktop bridges.
//
// One Electron desktop app opens one WebSocket and registers one or more
// user sessions.  The registry maps sessions → connections so that tool calls
// can be forwarded to the correct desktop machine.
// ---------------------------------------------------------------------------

import type { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolCallRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolCallResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

interface PendingCall {
  resolve: (value: ToolCallResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface BridgeConnection {
  ws: WebSocket;
  connectedAt: number;
}

// ---------------------------------------------------------------------------
// DesktopBridgeRegistry
// ---------------------------------------------------------------------------

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

export class DesktopBridgeRegistry {
  /** connectionId → BridgeConnection */
  private connections = new Map<string, BridgeConnection>();

  /** sessionId → connectionId */
  private sessionMap = new Map<string, string>();

  /** callId → PendingCall */
  private pendingCalls = new Map<string, PendingCall>();

  /** Tool timeout in milliseconds. */
  private toolTimeoutMs: number;

  constructor(options?: { toolTimeoutMs?: number }) {
    this.toolTimeoutMs = options?.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  }

  // ── Connection lifecycle ──────────────────────────────────────────────────

  /**
   * Register a new WebSocket connection.
   * Returns a connection ID that the caller should use for bindSession.
   */
  register(ws: WebSocket): string {
    const connectionId = randomUUID();
    this.connections.set(connectionId, { ws, connectedAt: Date.now() });

    ws.on('message', (raw) => {
      this.handleMessage(connectionId, raw);
    });

    ws.on('close', () => {
      this.unregister(connectionId);
    });

    ws.on('error', () => {
      // 'close' will fire after 'error' — cleanup happens there
    });

    return connectionId;
  }

  /** Remove a connection and clean up all its sessions + pending calls. */
  unregister(connectionId: string): void {
    this.connections.delete(connectionId);

    // Remove all session → connection mappings for this connection
    for (const [sid, cid] of this.sessionMap.entries()) {
      if (cid === connectionId) {
        this.sessionMap.delete(sid);
      }
    }

    // Reject all pending calls for this connection
    for (const [callId, pending] of this.pendingCalls.entries()) {
      // We could track which connection owns each call, but since one
      // desktop typically has one connection it's simpler to just clean
      // everything. Revisit if multi-connection per desktop becomes a thing.
      clearTimeout(pending.timer);
      pending.reject(new Error('Desktop bridge disconnected'));
      this.pendingCalls.delete(callId);
    }
  }

  /** Return the number of active connections. */
  get connectionCount(): number {
    return this.connections.size;
  }

  // ── Session binding ───────────────────────────────────────────────────────

  /** Associate a session with a bridge connection. */
  bindSession(connectionId: string, sessionId: string): void {
    if (!this.connections.has(connectionId)) {
      throw new Error(`Connection ${connectionId} not found`);
    }
    // If the session was previously bound to another connection, clean up
    const oldConnectionId = this.sessionMap.get(sessionId);
    if (oldConnectionId && oldConnectionId !== connectionId) {
      // The old connection is probably stale — just overwrite
    }
    this.sessionMap.set(sessionId, connectionId);
  }

  /** Remove a session binding. */
  unbindSession(sessionId: string): void {
    this.sessionMap.delete(sessionId);
  }

  /** Check whether a session has an active desktop bridge. */
  hasBridge(sessionId: string): boolean {
    const connectionId = this.sessionMap.get(sessionId);
    if (!connectionId) return false;
    return this.connections.has(connectionId);
  }

  // ── Tool call forwarding ──────────────────────────────────────────────────

  /**
   * Forward a tool call to the desktop bridge for the given session.
   * Returns a Promise that resolves when the desktop replies.
   */
  callTool(sessionId: string, tool: string, args: unknown, timeoutMs?: number): Promise<ToolCallResult> {
    const connectionId = this.sessionMap.get(sessionId);
    if (!connectionId) {
      return Promise.reject(new Error(`No desktop bridge registered for session ${sessionId}`));
    }

    const conn = this.connections.get(connectionId);
    if (!conn) {
      // Session map is stale — clean up
      this.sessionMap.delete(sessionId);
      return Promise.reject(new Error(`Desktop bridge connection ${connectionId} is gone`));
    }

    const callId = randomUUID();
    const effectiveTimeout = timeoutMs ?? this.toolTimeoutMs;

    return new Promise<ToolCallResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(callId);
        reject(new Error(`Tool call ${callId} timed out after ${effectiveTimeout}ms`));
      }, effectiveTimeout);

      this.pendingCalls.set(callId, { resolve, reject, timer });

      try {
        conn.ws.send(JSON.stringify({
          type: 'tool_call',
          id: callId,
          tool,
          args,
        }));
      } catch (err: any) {
        clearTimeout(timer);
        this.pendingCalls.delete(callId);
        reject(new Error(`Failed to send tool call: ${err.message}`));
      }
    });
  }

  // ── Message handling ──────────────────────────────────────────────────────

  private handleMessage(connectionId: string, raw: WebSocket.RawData): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // silently drop malformed messages
    }

    switch (msg.type) {
      case 'register': {
        const sessionId = msg.sessionId as string | undefined;
        if (sessionId) {
          this.bindSession(connectionId, sessionId);
          // Send back the tool route config (allowedRoots etc.)
          // This is populated by the agent-factory context injection
        }
        break;
      }

      case 'unregister': {
        const sessionId = msg.sessionId as string | undefined;
        if (sessionId) {
          this.unbindSession(sessionId);
        }
        break;
      }

      case 'tool_result': {
        const callId = msg.id as string | undefined;
        if (!callId) break;
        const pending = this.pendingCalls.get(callId);
        if (!pending) break; // already timed out or resolved

        clearTimeout(pending.timer);
        this.pendingCalls.delete(callId);

        const result: ToolCallResult = {
          ok: msg.ok === true,
          data: msg.data,
          error: msg.error as string | undefined,
        };
        pending.resolve(result);
        break;
      }

      case 'ping': {
        // Reply with pong to keep the connection alive
        const conn = this.connections.get(connectionId);
        if (conn && conn.ws.readyState === 1) { // WebSocket.OPEN = 1
          try {
            conn.ws.send(JSON.stringify({ type: 'pong' }));
          } catch { /* best effort */ }
        }
        break;
      }

      default:
        // Unknown message type — ignore
        break;
    }
  }

  /**
   * Send arbitrary JSON to a specific connection.
   */
  sendTo(connectionId: string, msg: Record<string, unknown>): void {
    const conn = this.connections.get(connectionId);
    if (conn && conn.ws.readyState === 1) {
      conn.ws.send(JSON.stringify(msg));
    }
  }
}
