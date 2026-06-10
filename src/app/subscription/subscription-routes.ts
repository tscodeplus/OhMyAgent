/**
 * Subscription API Routes
 *
 * Fastify plugin that registers REST endpoints for subscription management.
 * All login progress events are pushed via WebSocket so the frontend can
 * show real-time updates during OAuth flows.
 *
 * Routes:
 *   GET    /api/subscriptions               — list all provider statuses
 *   POST   /api/subscriptions/login          — start OAuth login (returns immediately; progress via WS)
 *   DELETE /api/subscriptions/:providerId    — logout / remove credentials
 *   POST   /api/subscriptions/:providerId/refresh — force token refresh
 */

import type { FastifyInstance } from 'fastify';
import type { SubscriptionService, SubscriptionProgressEvent } from './subscription-service.js';
import type { WebSocketManager } from '../webui/websocket.js';
import { getOAuthProvider, getOAuthProviders } from '../../pi-mono/ai/utils/oauth/index.js';
import type { OAuthLoginCallbacks } from '../../pi-mono/ai/utils/oauth/types.js';

export interface SubscriptionRouteConfig {
  subscriptionService: SubscriptionService;
  wsManager: WebSocketManager;
}

/** Track in-progress login flows to prevent duplicate login attempts. */
const activeLogins = new Map<string, Promise<void>>();

/**
 * Push a subscription progress event to WebSocket subscribers on the
 * channel "subscription:{providerId}".
 */
function pushProgress(
  wsManager: WebSocketManager,
  event: SubscriptionProgressEvent,
): void {
  wsManager.broadcastToChannel(`subscription:${event.providerId}`, {
    type: 'subscription_progress',
    providerId: event.providerId,
    stage: event.type,
    data: event.data,
  });
}

export function registerSubscriptionRoutes(
  app: FastifyInstance,
  cfg: SubscriptionRouteConfig,
): void {
  const { subscriptionService, wsManager } = cfg;

  // ── GET /api/subscriptions — list all providers ──────────────────────

  app.get('/api/subscriptions', async (_request, reply) => {
    const statuses = await subscriptionService.listStatuses();
    return reply.send({ subscriptions: statuses });
  });

  // ── POST /api/subscriptions/login — start login flow ─────────────────

  app.post('/api/subscriptions/login', async (request, reply) => {
    const { providerId } = (request.body ?? {}) as { providerId?: string };

    if (!providerId || typeof providerId !== 'string') {
      return reply.status(400).send({ error: 'Missing or invalid providerId' });
    }

    const provider = getOAuthProvider(providerId);
    if (!provider) {
      return reply.status(404).send({ error: `Unknown provider: ${providerId}` });
    }

    // Prevent duplicate login flows for the same provider
    if (activeLogins.has(providerId)) {
      return reply.status(409).send({
        error: `Login already in progress for ${providerId}`,
      });
    }

    // Build callbacks that push progress via WebSocket
    const callbacks: OAuthLoginCallbacks = {
      onAuth: (info) => {
        pushProgress(wsManager, {
          type: 'auth_url',
          providerId,
          data: { url: info.url, instructions: info.instructions },
        });
      },

      onDeviceCode: (info) => {
        pushProgress(wsManager, {
          type: 'device_code',
          providerId,
          data: {
            userCode: info.userCode,
            verificationUri: info.verificationUri,
            intervalSeconds: info.intervalSeconds,
            expiresInSeconds: info.expiresInSeconds,
          },
        });
      },

      onProgress: (message) => {
        pushProgress(wsManager, {
          type: 'progress',
          providerId,
          data: { message },
        });
      },

      onPrompt: async (_prompt) => {
        // Server-side cannot handle interactive prompts.
        // If a provider requires one, the CLI is the right interface.
        throw new Error(
          'Interactive prompt not supported via WebUI. Use CLI: ohmyagent login ' + providerId,
        );
      },

      onSelect: async (_selectPrompt) => {
        throw new Error(
          'Interactive selection not supported via WebUI. Use CLI: ohmyagent login ' + providerId,
        );
      },

      onManualCodeInput: async () => {
        throw new Error(
          'Manual code input not supported via WebUI. Use CLI: ohmyagent login ' + providerId,
        );
      },
    };

    // Start login in background so we can respond immediately
    const loginPromise = subscriptionService
      .login(providerId, callbacks)
      .then((credentials) => {
        activeLogins.delete(providerId);
        pushProgress(wsManager, {
          type: 'success',
          providerId,
          data: { expiresAt: credentials.expires },
        });
      })
      .catch((err: Error) => {
        activeLogins.delete(providerId);
        pushProgress(wsManager, {
          type: 'error',
          providerId,
          data: { message: err.message },
        });
      });

    activeLogins.set(providerId, loginPromise);

    return reply.send({ accepted: true, providerId });
  });

  // ── DELETE /api/subscriptions/:providerId — logout ───────────────────

  app.delete('/api/subscriptions/:providerId', async (request, reply) => {
    const { providerId } = request.params as { providerId: string };

    // Abort any in-progress login for this provider
    activeLogins.delete(providerId);

    await subscriptionService.logout(providerId);
    return reply.send({ ok: true, providerId });
  });

  // ── POST /api/subscriptions/:providerId/refresh — refresh token ──────

  app.post('/api/subscriptions/:providerId/refresh', async (request, reply) => {
    const { providerId } = request.params as { providerId: string };

    const credentials = await subscriptionService.refreshCredential(providerId);
    if (!credentials) {
      return reply.status(404).send({ error: `No credentials found for ${providerId}` });
    }

    return reply.send({
      ok: true,
      providerId,
      expiresAt: credentials.expires,
    });
  });
}
