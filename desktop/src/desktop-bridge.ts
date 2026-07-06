// ---------------------------------------------------------------------------
// DesktopBridge — WebSocket client that connects to a remote OhMyAgent gateway
// and exposes local tool execution (file_read, file_write, shell) back to it.
// ---------------------------------------------------------------------------
//
// Protocol (JSON messages over WebSocket):
//   Desktop → Gateway:  { type:"register", sessionId, capabilities:[...] }
//   Gateway → Desktop:  { type:"tool_call", id, tool, args:{...} }
//   Desktop → Gateway:  { type:"tool_result", id, ok:boolean, data?, error? }
//   Gateway → Desktop:  { type:"config", allowedRoots:[...], deniedPatterns:[...] }
//   Gateway → Desktop:  { type:"pong" }
//   Desktop → Gateway:  { type:"ping" }
//   Desktop → Gateway:  { type:"unregister", sessionId }
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BridgeStatus = 'disconnected' | 'connecting' | 'connected';

export interface DesktopBridgeOptions {
  gatewayUrl: string; // ws://host:port
  token: string;
  logger?: {
    debug(msg: string): void;
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
}

interface ToolCallMessage {
  type: 'tool_call';
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

interface ToolResultMessage {
  type: 'tool_result';
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

interface ConfigMessage {
  type: 'config';
  allowedRoots: string[];
  deniedPatterns: string[];
}

interface PongMessage {
  type: 'pong';
}

type GatewayMessage = ToolCallMessage | ConfigMessage | PongMessage;

type DesktopMessage =
  | { type: 'register'; sessionId: string; capabilities: string[] }
  | { type: 'unregister'; sessionId: string }
  | ToolResultMessage
  | { type: 'ping' };

// ---------------------------------------------------------------------------
// Tool executors
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 100_000;
const SHELL_TIMEOUT_MS = 60_000;
const SHELL_MAX_BUFFER = 10 * 1024 * 1024;

/** Check whether a resolved path is within one of the allowed roots. */
function isPathAllowed(target: string, allowedRoots: string[]): boolean {
  if (!allowedRoots.length) return true; // no restriction
  const normalized = path.resolve(target);
  return allowedRoots.some((root) => {
    const normalizedRoot = path.resolve(root);
    return normalized.startsWith(normalizedRoot + path.sep) || normalized === normalizedRoot;
  });
}

/** Check whether a resolved path matches any denied pattern (glob-style prefix). */
function isPathDenied(target: string, deniedPatterns: string[]): boolean {
  if (!deniedPatterns.length) return false;
  const basename = path.basename(target);
  const ext = path.extname(basename);
  return deniedPatterns.some((p) => {
    if (p.startsWith('*.')) return ext === p.slice(1); // *.pem, *.env
    if (p.endsWith('*')) return basename.startsWith(p.slice(0, -1)); // secret-*
    return basename === p;
  });
}

function executeFileRead(filePath: string, _args: Record<string, unknown>): string {
  const resolved = path.resolve(filePath);
  const content = fs.readFileSync(resolved, 'utf-8');
  if (content.length > MAX_FILE_SIZE) {
    return content.slice(0, MAX_FILE_SIZE) + `\n\n... (${content.length - MAX_FILE_SIZE} more characters)`;
  }
  return content;
}

function executeFileWrite(filePath: string, args: Record<string, unknown>): string {
  const resolved = path.resolve(filePath);
  const content = String(args.content ?? '');
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolved, content, 'utf-8');
  return `Successfully wrote ${Buffer.byteLength(content, 'utf-8')} bytes to ${resolved}`;
}

function executeShell(args: Record<string, unknown>): string {
  const command = String(args.command ?? '');
  const timeout = (args.timeoutMs as number) ?? SHELL_TIMEOUT_MS;
  const result = execSync(command, {
    timeout,
    maxBuffer: SHELL_MAX_BUFFER,
    encoding: 'utf-8',
  });
  return result || '(command completed with no output)';
}

function executeTool(tool: string, args: Record<string, unknown>): { ok: true; data: string } | { ok: false; error: string } {
  try {
    const filePath = (args.path ?? args.filePath ?? '') as string;
    let data: string;
    switch (tool) {
      case 'file_read':
        data = executeFileRead(filePath, args);
        break;
      case 'file_write':
        data = executeFileWrite(filePath, args);
        break;
      case 'shell':
        data = executeShell(args);
        break;
      default:
        return { ok: false, error: `Unknown tool: ${tool}` };
    }
    return { ok: true, data };
  } catch (err: any) {
    const msg = err?.stderr || err?.message || String(err);
    return { ok: false, error: msg.trim() };
  }
}

// ---------------------------------------------------------------------------
// DesktopBridge
// ---------------------------------------------------------------------------

export class DesktopBridge {
  private ws: WebSocket | null = null;
  private status: BridgeStatus = 'disconnected';
  private sessions = new Set<string>();
  private allowedRoots: string[] = [];
  private deniedPatterns: string[] = [];
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly maxReconnectAttempts = 5;
  private readonly gatewayUrl: string;
  private readonly token: string;
  private readonly logger: DesktopBridgeOptions['logger'];

  constructor(options: DesktopBridgeOptions) {
    this.gatewayUrl = options.gatewayUrl;
    this.token = options.token;
    this.logger = options.logger;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  getStatus(): BridgeStatus {
    return this.status;
  }

  /**
   * Connect to the gateway and register all known sessions.
   */
  async start(): Promise<void> {
    if (this.status === 'connecting' || this.status === 'connected') return;
    this.connect();
  }

  /** Register a session so tool calls for it are forwarded here. */
  registerSession(sessionId: string): void {
    this.sessions.add(sessionId);
    this.logger?.debug(`[DesktopBridge] Session registered: ${sessionId}`);
    if (this.status === 'connected' && this.ws) {
      this.send({ type: 'register', sessionId, capabilities: ['file_read', 'file_write', 'shell'] });
    }
  }

  /** Unregister a session (e.g. chat closed). */
  unregisterSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.logger?.debug(`[DesktopBridge] Session unregistered: ${sessionId}`);
    if (this.status === 'connected' && this.ws) {
      this.send({ type: 'unregister', sessionId });
    }
  }

  /** Disconnect and clean up. */
  stop(): void {
    this.clearTimers();
    if (this.ws) {
      // Unregister all sessions before closing
      for (const sid of this.sessions) {
        try { this.send({ type: 'unregister', sessionId: sid }); } catch { /* */ }
      }
      this.sessions.clear();
      try { this.ws.close(1000); } catch { /* */ }
      this.ws = null;
    }
    this.status = 'disconnected';
    this.reconnectAttempts = 0;
    this.logger?.info('[DesktopBridge] Stopped');
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private connect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger?.warn('[DesktopBridge] Max reconnect attempts reached, giving up');
      this.status = 'disconnected';
      return;
    }

    this.status = 'connecting';
    this.logger?.info(`[DesktopBridge] Connecting to ${this.gatewayUrl} (attempt ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})`);

    const ws = new WebSocket(this.gatewayUrl, {
      headers: { Authorization: `Bearer ${this.token}` },
    });

    ws.on('open', () => {
      this.logger?.info('[DesktopBridge] WebSocket connected');
      this.status = 'connected';
      this.reconnectAttempts = 0;
      this.ws = ws;

      // Register all known sessions
      for (const sid of this.sessions) {
        this.send({ type: 'register', sessionId: sid, capabilities: ['file_read', 'file_write', 'shell'] });
      }

      // Start heartbeat
      this.startPing();
    });

    ws.on('message', (raw) => {
      let msg: GatewayMessage;
      try {
        msg = JSON.parse(raw.toString()) as GatewayMessage;
      } catch {
        this.logger?.warn(`[DesktopBridge] Invalid JSON message received`);
        return;
      }
      this.handleMessage(msg);
    });

    ws.on('close', (code, reason) => {
      this.logger?.warn(`[DesktopBridge] WebSocket closed: ${code} ${reason?.toString() ?? ''}`);
      this.ws = null;
      this.status = 'disconnected';
      this.clearTimers();
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      this.logger?.error(`[DesktopBridge] WebSocket error: ${err.message}`);
      // 'close' will fire after 'error'
    });
  }

  private handleMessage(msg: GatewayMessage): void {
    switch (msg.type) {
      case 'tool_call': {
        // Check path safety before executing
        const filePath = (msg.args.path ?? msg.args.filePath ?? '') as string;
        if (filePath) {
          const resolved = path.resolve(filePath);
          if (!isPathAllowed(resolved, this.allowedRoots)) {
            this.sendResult(msg.id, { ok: false, error: `Access denied: '${filePath}' is outside allowed roots` });
            return;
          }
          if (isPathDenied(resolved, this.deniedPatterns)) {
            this.sendResult(msg.id, { ok: false, error: `Access denied: '${path.basename(filePath)}' matches denied pattern` });
            return;
          }
        }

        const result = executeTool(msg.tool, msg.args);
        this.sendResult(msg.id, result);
        break;
      }
      case 'config': {
        this.allowedRoots = msg.allowedRoots ?? [];
        this.deniedPatterns = msg.deniedPatterns ?? [];
        this.logger?.info(`[DesktopBridge] Config updated: ${this.allowedRoots.length} allowed roots, ${this.deniedPatterns.length} denied patterns`);
        break;
      }
      case 'pong': {
        // Heartbeat reply — nothing to do
        break;
      }
      default: {
        this.logger?.warn(`[DesktopBridge] Unknown message type: ${(msg as any).type}`);
      }
    }
  }

  private send(msg: DesktopMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  private sendResult(id: string, result: { ok: boolean; data?: string; error?: string }): void {
    const msg: ToolResultMessage = {
      type: 'tool_result',
      id,
      ok: result.ok,
      data: result.ok ? { content: result.data } : undefined,
      error: result.ok ? undefined : result.error,
    };
    this.send(msg);
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      this.send({ type: 'ping' });
    }, 30_000);
  }

  private clearTimers(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger?.error('[DesktopBridge] Max reconnect attempts reached');
      this.status = 'disconnected';
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000);
    this.logger?.warn(`[DesktopBridge] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
