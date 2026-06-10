/**
 * WebSocket infrastructure for real-time push notifications.
 *
 * Uses the `ws` library directly (NOT @fastify/websocket) to avoid a
 * critical conflict: @fastify/websocket intercepts ALL HTTP Upgrade
 * requests and routes them through Fastify's normal request pipeline.
 * For paths without a websocket handler (like Vite's HMR path /webui/),
 * it closes the connection — which kills Vite's HMR and causes the
 * browser to fall back to infinite full-page reloads.
 *
 * By using ws.Server with noServer:true and only handling the /ws path,
 * we leave all other Upgrade requests (Vite HMR, etc.) untouched.
 *
 * Message types:
 *   - chat_chunk: Streaming chat chunks
 *   - approval_required: New approval request
 *   - approval_resolved: Approval request resolved
 *   - agent_status: Agent state changes
 *   - channel_status: Channel connectivity changes
 *   - config_changed: Config updated
 */

import type { FastifyInstance } from 'fastify';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { verifyToken } from '../webui-auth.js';

interface WSClient {
  socket: WebSocket;
  subscribedChannels: Set<string>;
}

export class WebSocketManager {
  private clients: Map<WebSocket, WSClient> = new Map();
  private channelSubscribers: Map<string, Set<WebSocket>> = new Map();

  /**
   * Register a new WebSocket connection.
   */
  register(socket: WebSocket, token: string): boolean {
    // Token verified already by the upgrade handler
    const client: WSClient = {
      socket,
      subscribedChannels: new Set(),
    };
    this.clients.set(socket, client);

    socket.on('close', () => {
      this.unregister(socket);
    });

    socket.on('error', () => {
      this.unregister(socket);
    });

    // Handle client → server messages (channel subscriptions, etc.)
    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'subscribe' && typeof msg.channel === 'string') {
          this.subscribeClient(socket, msg.channel);
        }
      } catch {
        // Ignore malformed messages
      }
    });

    // Send welcome message
    this.sendToClient(socket, { type: 'connected', message: 'WebSocket connected' });
    console.log(`[ws] client connected, total=${this.clients.size}`);

    return true;
  }

  private unregister(socket: WebSocket): void {
    const client = this.clients.get(socket);
    if (client) {
      for (const channel of client.subscribedChannels) {
        this.channelSubscribers.get(channel)?.delete(socket);
      }
      this.clients.delete(socket);
      console.log(`[ws] client disconnected, total=${this.clients.size}`);
    }
  }

  /**
   * Broadcast a message to all connected clients.
   */
  broadcast(message: Record<string, unknown>): void {
    const data = JSON.stringify(message);
    for (const [socket] of this.clients) {
      if (socket.readyState === socket.OPEN) {
        socket.send(data);
      }
    }
  }

  /**
   * Broadcast a message to a specific channel's subscribers.
   */
  broadcastToChannel(channel: string, message: Record<string, unknown>): void {
    const subscribers = this.channelSubscribers.get(channel);
    if (!subscribers) return;
    const data = JSON.stringify(message);
    for (const socket of subscribers) {
      if (socket.readyState === socket.OPEN) {
        socket.send(data);
      }
    }
  }

  /**
   * Send a message to a specific client.
   */
  sendToClient(socket: WebSocket, message: Record<string, unknown>): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  /**
   * Subscribe a client to a channel.
   */
  subscribeClient(socket: WebSocket, channel: string): void {
    const client = this.clients.get(socket);
    if (!client) return;
    client.subscribedChannels.add(channel);

    if (!this.channelSubscribers.has(channel)) {
      this.channelSubscribers.set(channel, new Set());
    }
    this.channelSubscribers.get(channel)!.add(socket);
  }

  get connectedCount(): number {
    return this.clients.size;
  }
}

/**
 * Create a Fastify plugin that registers WebSocket support.
 *
 * Uses the `ws` library directly with noServer mode to only handle the
 * /ws path — all other Upgrade requests (Vite HMR, etc.) pass through
 * untouched.
 *
 * Usage: app.register(createWebSocketPlugin(manager))
 */
export function createWebSocketPlugin(manager: WebSocketManager) {
  return async function wsPlugin(app: FastifyInstance): Promise<void> {
    // Create a WebSocket server in noServer mode so we control exactly
    // which Upgrade requests are handled.
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1048576 });

    // Hook into the underlying HTTP server's upgrade event.  We only
    // handle /ws — Vite's own WS server handles /webui/ for HMR.
    app.server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

      if (url.pathname !== '/ws') {
        // Not our path — leave it for the next listener (Vite HMR, etc.)
        return;
      }

      const token = url.searchParams.get('token') || '';

      if (!verifyToken(token)) {
        // Send 401 and close — don't upgrade
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        manager.register(ws, token);
        wss.emit('connection', ws, request);
      });
    });

    // Close all WS clients on server shutdown
    app.addHook('onClose', (_instance, done) => {
      for (const client of wss.clients) {
        client.close();
      }
      wss.close();
      done();
    });
  };
}
