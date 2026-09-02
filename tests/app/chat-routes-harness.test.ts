/**
 * Tests for the harness proposal decision endpoint in chat-routes.ts
 * (POST /api/harness/proposals/:id/decide).
 *
 * Verifies the SSE ↔ HTTP registry bridge: a pending approval promise
 * registered via the shared harnessApprovalRegistry is resolved when the
 * frontend posts the user's button choice, plus error handling for unknown
 * proposals and invalid actions.
 */

import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import type { HarnessApprovalResult } from '../../src/harness/types.js';

import { registerChatRoutes } from '../../src/app/webui/chat-routes.js';

function makeApp() {
  const registry = new Map<string, (result: HarnessApprovalResult) => void>();
  const app = Fastify({ logger: false });

  registerChatRoutes(app, {
    agentService: {} as any,
    projectStore: {} as any,
    harnessApprovalRegistry: registry,
  } as any);

  return { app, registry };
}

describe('POST /api/harness/proposals/:id/decide', () => {
  it('resolves a pending proposal with approve', async () => {
    const { app, registry } = makeApp();
    const resolver = vi.fn();
    registry.set('prop-1', resolver);

    const res = await app.inject({
      method: 'POST',
      url: '/api/harness/proposals/prop-1/decide',
      payload: { action: 'approve' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(resolver).toHaveBeenCalledWith({ decision: 'approve' });
    // The resolved proposal is removed from the registry.
    expect(registry.has('prop-1')).toBe(false);
  });

  it('maps reject and ignore actions onto the reject decision', async () => {
    const { app, registry } = makeApp();
    for (const [id, action] of [
      ['prop-2', 'reject'],
      ['prop-3', 'ignore'],
    ] as const) {
      const resolver = vi.fn();
      registry.set(id, resolver);

      const res = await app.inject({
        method: 'POST',
        url: `/api/harness/proposals/${id}/decide`,
        payload: { action },
      });

      expect(res.statusCode).toBe(200);
      expect(resolver).toHaveBeenCalledWith({ decision: 'reject' });
    }
  });

  it('passes the user-edited value through for edit_submit', async () => {
    const { app, registry } = makeApp();
    const resolver = vi.fn();
    registry.set('prop-4', resolver);

    const res = await app.inject({
      method: 'POST',
      url: '/api/harness/proposals/prop-4/decide',
      payload: { action: 'edit_submit', editedValue: 'new content' },
    });

    expect(res.statusCode).toBe(200);
    expect(resolver).toHaveBeenCalledWith({
      decision: 'edit',
      editedValue: 'new content',
    });
  });

  it('returns 404 for an unknown or expired proposal', async () => {
    const { app } = makeApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/harness/proposals/ghost/decide',
      payload: { action: 'approve' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ ok: false, error: 'unknown or expired proposal' });
  });

  it('returns 400 for an unknown action', async () => {
    const { app, registry } = makeApp();
    registry.set('prop-5', vi.fn());

    const res = await app.inject({
      method: 'POST',
      url: '/api/harness/proposals/prop-5/decide',
      payload: { action: 'explode' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ ok: false, error: 'unknown action: explode' });
  });

  it('does not resolve the promise twice (registry entry removed on first hit)', async () => {
    const { app, registry } = makeApp();
    const resolver = vi.fn();
    registry.set('prop-6', resolver);

    await app.inject({
      method: 'POST',
      url: '/api/harness/proposals/prop-6/decide',
      payload: { action: 'approve' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/harness/proposals/prop-6/decide',
      payload: { action: 'approve' },
    });

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(second.statusCode).toBe(404);
  });
});
