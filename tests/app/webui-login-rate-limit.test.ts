/**
 * Regression tests for POST /api/auth/login — the only authentication factor on
 * the public WebUI surface (webuiAuthHook exempts the path), which used to be
 * reachable without any throttle at all.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createFilesHarness,
  TEST_TOKEN,
  type FilesHarness,
} from './webui-files-harness.js';
import { resetLoginRateLimits, LOGIN_MAX_ATTEMPTS_PER_IP } from '../../src/app/webui/chat-routes.js';

let h: FilesHarness;

beforeEach(async () => {
  resetLoginRateLimits();
  h = await createFilesHarness({ withChatRoutes: true });
});

afterEach(async () => {
  await h.cleanup();
  resetLoginRateLimits();
});

async function attempt(token: string) {
  // Login is a public endpoint: no bearer header is sent (and the harness would
  // otherwise add the valid one by default).
  return h.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { token },
  });
}

describe('POST /api/auth/login rate limiting', () => {
  it('accepts a correct token while inside the budget', async () => {
    const res = await attempt(TEST_TOKEN);
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('still answers 401 for a wrong token inside the budget', async () => {
    const res = await attempt('definitely-not-the-token');
    expect(res.statusCode).toBe(401);
  });

  it('429s once the per-IP budget is spent, and the throttle does not leak the token', async () => {
    let lastStatus = 0;
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS_PER_IP; i++) {
      lastStatus = (await attempt('guessed-token-' + i)).statusCode;
      expect(lastStatus).toBe(401);
    }

    const blocked = await attempt(TEST_TOKEN);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe('Too Many Requests');
    expect(blocked.headers['retry-after']).toBeDefined();
    // A throttled request must never be upgraded to a successful login.
    expect(blocked.body).not.toContain(TEST_TOKEN);

    // Every further attempt stays blocked, correct token or not.
    expect((await attempt(TEST_TOKEN)).statusCode).toBe(429);
  });
});
