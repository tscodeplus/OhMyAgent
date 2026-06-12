/**
 * Subscription API Routes
 *
 * Fastify plugin that registers REST endpoints for subscription management.
 * All login progress events are pushed via WebSocket so the frontend can
 * show real-time updates during OAuth flows.
 *
 * Routes:
 *   GET    /api/subscriptions                    — list all provider statuses
 *   POST   /api/subscriptions/login              — start OAuth login (returns immediately; progress via WS)
 *   POST   /api/subscriptions/login/respond      — send user response back to a pending interactive prompt
 *   DELETE /api/subscriptions/:providerId        — logout / remove credentials
 *   POST   /api/subscriptions/:providerId/refresh — force token refresh
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { SubscriptionService, SubscriptionProgressEvent } from './subscription-service.js';
import type { WebSocketManager } from '../webui/websocket.js';
import { getOAuthProvider, getOAuthProviders } from '../../pi-mono/ai/utils/oauth/index.js';
import type {
  OAuthLoginCallbacks,
  OAuthPrompt,
  OAuthSelectPrompt,
} from '../../pi-mono/ai/utils/oauth/types.js';

export interface SubscriptionRouteConfig {
  subscriptionService: SubscriptionService;
  wsManager: WebSocketManager;
  /** Live config ref — mutated in-place after login to inject API keys immediately. */
  liveConfigRef?: { current: import('../types.js').AppConfig };
}

/** Track in-progress login flows to prevent duplicate login attempts. */
const activeLogins = new Map<string, Promise<void>>();

/**
 * Monotonic generation counter per provider.  Each new login increments it.
 * .then()/.catch() handlers compare their captured generation against the
 * current value to detect superseded logins reliably, without relying on
 * promise-identity timing.
 */
const loginGenerations = new Map<string, number>();

/**
 * Pending interactive request — waiting for the WebUI to send back a response.
 */
interface PendingRequest {
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Per-provider pending requests: providerId → (requestId → PendingRequest). */
const pendingRequests = new Map<string, Map<string, PendingRequest>>();

/** Timeout for interactive prompts (5 minutes). */
const PROMPT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Create a pending request that will be resolved when the WebUI responds
 * via POST /api/subscriptions/login/respond.
 */
function createPendingRequest(providerId: string): { requestId: string; promise: Promise<string> } {
  const requestId = randomUUID();
  let resolver!: (value: string) => void;
  let rejecter!: (err: Error) => void;

  const promise = new Promise<string>((resolve, reject) => {
    resolver = resolve;
    rejecter = reject;
  });

  const timer = setTimeout(() => {
    // Remove from per-provider map
    const providerPending = pendingRequests.get(providerId);
    if (providerPending) {
      providerPending.delete(requestId);
      if (providerPending.size === 0) pendingRequests.delete(providerId);
    }
    rejecter(new Error(`Login prompt timed out after ${PROMPT_TIMEOUT_MS / 60000} minutes`));
  }, PROMPT_TIMEOUT_MS);

  let providerPending = pendingRequests.get(providerId);
  if (!providerPending) {
    providerPending = new Map();
    pendingRequests.set(providerId, providerPending);
  }
  providerPending.set(requestId, { resolve: resolver, reject: rejecter, timer });

  return { requestId, promise };
}

/**
 * Resolve a pending request with the user's response.
 * Searches all providers since requestId is globally unique.
 * Returns true if the request was found and resolved.
 */
function resolvePendingRequest(requestId: string, response: string): boolean {
  for (const [providerId, providerPending] of pendingRequests) {
    const pending = providerPending.get(requestId);
    if (pending) {
      clearTimeout(pending.timer);
      providerPending.delete(requestId);
      if (providerPending.size === 0) pendingRequests.delete(providerId);
      pending.resolve(response);
      return true;
    }
  }
  return false;
}

/**
 * Reject all pending requests for a given provider (e.g. on logout or error).
 * Does NOT affect pending requests of other providers.
 */
function rejectPendingForProvider(providerId: string): void {
  const providerPending = pendingRequests.get(providerId);
  if (!providerPending) return;
  pendingRequests.delete(providerId);
  for (const [, pending] of providerPending) {
    clearTimeout(pending.timer);
    pending.reject(new Error('Login cancelled'));
  }
}

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

  // ── POST /api/subscriptions/login/respond — answer interactive prompt ─

  app.post('/api/subscriptions/login/respond', async (request, reply) => {
    const { requestId, response } = (request.body ?? {}) as {
      requestId?: string;
      response?: string;
    };

    if (!requestId || typeof requestId !== 'string') {
      return reply.status(400).send({ error: 'Missing or invalid requestId' });
    }

    if (typeof response !== 'string') {
      return reply.status(400).send({ error: 'Missing or invalid response' });
    }

    const found = resolvePendingRequest(requestId, response);
    if (!found) {
      return reply.status(404).send({ error: 'No pending request found (may have timed out or already been answered)' });
    }

    return reply.send({ accepted: true });
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

    // Cancel any previous login flow for this provider
    if (activeLogins.has(providerId)) {
      activeLogins.delete(providerId);
      rejectPendingForProvider(providerId);
    }

    // Bump generation so .then()/.catch() handlers from superseded logins
    // know to skip their event pushes.
    const generation = (loginGenerations.get(providerId) ?? 0) + 1;
    loginGenerations.set(providerId, generation);

    // Build callbacks that push progress via WebSocket and support
    // interactive prompts via the /respond endpoint.
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

      onPrompt: async (p: OAuthPrompt) => {
        const { requestId, promise } = createPendingRequest(providerId);
        pushProgress(wsManager, {
          type: 'prompt',
          providerId,
          data: {
            requestId,
            message: p.message,
            placeholder: p.placeholder,
            allowEmpty: p.allowEmpty,
          },
        });
        return await promise;
      },

      onSelect: async (p: OAuthSelectPrompt) => {
        const { requestId, promise } = createPendingRequest(providerId);
        pushProgress(wsManager, {
          type: 'select',
          providerId,
          data: {
            requestId,
            message: p.message,
            options: p.options,
          },
        });
        const result = await promise;
        // Empty response means cancelled
        if (!result) return undefined as unknown as string;
        return result;
      },

      onManualCodeInput: async () => {
        const { requestId, promise } = createPendingRequest(providerId);
        pushProgress(wsManager, {
          type: 'manual_code_input',
          providerId,
          data: { requestId },
        });
        return await promise;
      },
    };

    // Start login in background so we can respond immediately
    const loginPromise = subscriptionService
      .login(providerId, callbacks)
      .then(async (credentials) => {
        // Skip if a newer login for this provider has started
        if (loginGenerations.get(providerId) !== generation) return;
        activeLogins.delete(providerId);
        rejectPendingForProvider(providerId);

        // Inject the new API key into the live config immediately so the
        // user doesn't need to restart the server.
        if (cfg.liveConfigRef?.current) {
          try {
            await subscriptionService.applyCredentialsToConfig(cfg.liveConfigRef.current);
          } catch (err) {
            // Non-fatal — credentials are already persisted to auth.json.
            // Next restart will pick them up.
          }
        }

        pushProgress(wsManager, {
          type: 'success',
          providerId,
          data: { expiresAt: credentials.expires },
        });
      })
      .catch((err: Error) => {
        // Skip if a newer login for this provider has started
        if (loginGenerations.get(providerId) !== generation) return;
        activeLogins.delete(providerId);
        rejectPendingForProvider(providerId);
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
    rejectPendingForProvider(providerId);

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
