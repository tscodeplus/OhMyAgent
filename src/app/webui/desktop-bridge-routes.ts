// ---------------------------------------------------------------------------
// Desktop Bridge WebSocket endpoint.
//
// Follows the same pattern as websocket.ts: uses `ws` with noServer:true and
// only handles the /desktop/bridge path. All other Upgrade requests (Vite HMR
// at /webui/, the existing /ws) pass through untouched.
//
// Protocol (JSON messages):
//   Desktop → Gateway:  { type:"register",  sessionId, capabilities:[...] }
//   Desktop → Gateway:  { type:"unregister", sessionId }
//   Gateway → Desktop:  { type:"tool_call",  id, tool, args:{...} }
//   Desktop → Gateway:  { type:"tool_result", id, ok:boolean, data?, error? }
//   Gateway → Desktop:  { type:"config", allowedRoots:[...], deniedPatterns:[...] }
//   Desktop ↔ Gateway:  { type:"ping" } / { type:"pong" }
// ---------------------------------------------------------------------------

import type { FastifyInstance } from 'fastify';
import { WebSocketServer } from 'ws';
import { verifyToken } from '../webui-auth.js';
import { DesktopBridgeRegistry } from '../../agent/desktop-bridge-registry.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register the /desktop/bridge WebSocket endpoint on the Fastify server.
 * Returns the DesktopBridgeRegistry so callers can forward tool calls.
 */
export function registerDesktopBridge(app: FastifyInstance): DesktopBridgeRegistry {
  const registry = new DesktopBridgeRegistry();

  const wss = new WebSocketServer({ noServer: true, maxPayload: 10 * 1024 * 1024 }); // 10 MB max payload

  // Hook into the underlying HTTP server's upgrade event.
  // We only handle /desktop/bridge — the existing /ws handler and Vite's HMR
  // handler both check for their own paths and return early, so adding one
  // more listener to the same upgrade event is safe.
  app.server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    if (url.pathname !== '/desktop/bridge' && !url.pathname.startsWith('/desktop/bridge')) {
      // Not our path — leave it for the next listener (existing /ws, Vite HMR)
      return;
    }

    // Extract token from Authorization: Bearer <token> header,
    // or from ?token=<token> query parameter (fallback).
    const authHeader = request.headers['authorization'] || '';
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    const token = bearerMatch?.[1] ?? url.searchParams.get('token') ?? '';

    if (!verifyToken(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\n\r\n{"error":"invalid_token"}');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      const connectionId = registry.register(ws);
      wss.emit('connection', ws, request);

      // Send config to the bridge (allowedRoots and deniedPatterns are set
      // by the agent-factory context injection later — send empty defaults).
      registry.sendTo(connectionId, {
        type: 'config',
        allowedRoots: [],
        deniedPatterns: ['*.pem', '*.key', '.env', 'id_rsa', 'id_ed25519'],
      });
    });
  });

  // Clean up on server shutdown
  app.addHook('onClose', (_instance, done) => {
    for (const client of wss.clients) {
      client.close(1001, 'Server shutting down');
    }
    wss.close();
    done();
  });

  return registry;
}
