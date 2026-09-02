import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createFilesHarness,
  OUTSIDE_SECRET_BODY,
  type FilesHarness,
} from './webui-files-harness';
import { grantFileServeAccess } from '../../src/app/webui/files-routes';

/**
 * Report #6b option B: when a human approves a file-access card in the chat
 * channel, the agent approval flow calls grantFileServeAccess(path) so the
 * WebUI can serve that out-of-root path for the allowlist TTL. This asserts
 * the end-to-end effect through the real routes: 403 before the grant, 200
 * with the secret body after it — and the denial must never offer the client
 * a way to mint the grant itself.
 */

let h: FilesHarness;

beforeAll(async () => {
  h = await createFilesHarness();
});

afterAll(async () => {
  await h.cleanup();
});

describe('file-serve grant from the agent approval flow (option B)', () => {
  it('denies an out-of-root path before any approval exists', async () => {
    const res = await h.call('GET', `/api/files/serve?path=${encodeURIComponent(h.outsideSecretPath)}`);
    expect(res.statusCode).toBe(403);
    expect(res.json().needsApproval).toBeUndefined();
    expect(res.json().approvalId).toBeUndefined();
  });

  it('serves the path after grantFileServeAccess (simulated card approval)', async () => {
    grantFileServeAccess(h.outsideSecretPath);

    const res = await h.call('GET', `/api/files/serve?path=${encodeURIComponent(h.outsideSecretPath)}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(OUTSIDE_SECRET_BODY);
  });

  it('grants do not leak into the pending-approvals listing', async () => {
    grantFileServeAccess(h.outsideSecretPath);
    const pending = await h.call('GET', '/api/files/approvals');
    expect(pending.body).not.toContain(h.outsideSecretPath);
  });
});
