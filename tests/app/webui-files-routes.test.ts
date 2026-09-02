/**
 * Regression tests for the WebUI file routes (/api/files/*).
 *
 * Covers the three defects found in the 2026-09-01 review:
 *   1. GET /api/files/tree walked any caller-supplied absolute path with no
 *      confinement check while every sibling route confined to webui.file_root.
 *   2. GET /api/files/serve populated the approval map from the requesting
 *      client's own path argument, and POST /api/files/approve-serve accepted
 *      any id from that map — one caller could request and approve in turn and
 *      read any file on the host.
 *   3. HTML/SVG were served inline from the gateway origin (which holds the
 *      WebUI bearer token) with no nosniff, i.e. stored XSS → API takeover.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import {
  createFilesHarness,
  OUTSIDE_SECRET_BODY,
  HTML_BODY,
  SVG_BODY,
  type FilesHarness,
} from './webui-files-harness.js';
import { registerFileServeApproval } from '../../src/app/webui/files-routes.js';

let h: FilesHarness;

beforeEach(async () => {
  h = await createFilesHarness();
});

afterEach(async () => {
  await h.cleanup();
});

describe('GET /api/files/tree — confinement', () => {
  it('rejects an absolute root outside webui.file_root (the leak)', async () => {
    const res = await h.call('GET', `/api/files/tree?root=${encodeURIComponent(h.outsideDir)}`);

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('Path traversal denied');
    // Pre-fix this returned 200 and listed the whole directory.
    expect(res.body).not.toContain('secret.txt');
  });

  it('rejects /-escape via ../ traversal', async () => {
    const res = await h.call('GET', '/api/files/tree?root=../../../../etc');

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('Path traversal denied');
    expect(res.body).not.toContain('passwd');
  });

  it('rejects an escape written as a child of the root', async () => {
    const res = await h.call(
      'GET',
      `/api/files/tree?root=${encodeURIComponent(join(h.fileRoot, '..', '..', 'etc'))}`,
    );

    expect(res.statusCode).toBe(403);
  });

  it('still lists the default root and an explicit subdirectory of it', async () => {
    const defaulted = await h.call('GET', '/api/files/tree');
    expect(defaulted.statusCode).toBe(200);
    expect(defaulted.json().tree.map((n: { name: string }) => n.name)).toContain('notes.txt');

    const sub = await h.call(
      'GET',
      `/api/files/tree?root=${encodeURIComponent(join(h.fileRoot, 'sub'))}`,
    );
    expect(sub.statusCode).toBe(200);
    expect(sub.json().tree.map((n: { name: string }) => n.name)).toContain('inner.txt');
  });
});

describe('GET /api/files/content + /download — confinement', () => {
  it('content refuses to read a file outside the root, absolute or traversing', async () => {
    const abs = await h.call(
      'GET',
      `/api/files/content?path=${encodeURIComponent(h.outsideSecretPath)}`,
    );
    expect(abs.statusCode).toBe(403);
    expect(abs.body).not.toContain(OUTSIDE_SECRET_BODY);

    const traversal = await h.call('GET', '/api/files/content?path=../../../../etc/passwd');
    expect([403, 404]).toContain(traversal.statusCode);
    expect(traversal.body).not.toContain('root:');
  });

  it('download denies a path outside every served root', async () => {
    const res = await h.call('GET', `/api/files/download?path=${encodeURIComponent(h.outsideSecretPath)}`);

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('Path traversal denied');
    expect(res.body).not.toContain(OUTSIDE_SECRET_BODY);
  });

  it('download still serves a file inside the root, as an attachment with nosniff', async () => {
    const res = await h.call(
      'GET',
      `/api/files/download?path=${encodeURIComponent(join(h.fileRoot, 'notes.txt'))}`,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('root file body');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('GET /api/files/serve — out-of-root access is not self-serviceable', () => {
  it('denies an out-of-root path outright, with no approval offer', async () => {
    const res = await h.call('GET', `/api/files/serve?path=${encodeURIComponent(h.outsideSecretPath)}`);

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('Path traversal denied');
    // Pre-fix the 403 handed back { needsApproval, approvalId } for the caller's
    // own path — the first half of the self-approval chain.
    expect(res.json().needsApproval).toBeUndefined();
    expect(res.json().approvalId).toBeUndefined();
  });

  it('walks the full request→approve→read chain without ever getting the file', async () => {
    const probe = await h.call('GET', `/api/files/serve?path=${encodeURIComponent(h.outsideSecretPath)}`);
    expect(probe.statusCode).toBe(403);

    // Guessing an id is not enough — no such request exists.
    const invented = await h.call('POST', '/api/files/approve-serve', {
      payload: { approvalId: 'file-1-abc', decision: 'approve' },
    });
    expect(invented.statusCode).toBe(404);

    // Neither is a real, server-registered id without its grant.
    const registered = registerFileServeApproval({ path: h.outsideSecretPath });
    expect(registered).not.toBeNull();
    const withoutGrant = await h.call('POST', '/api/files/approve-serve', {
      payload: { approvalId: registered!.approvalId, decision: 'approve' },
    });
    expect(withoutGrant.statusCode).toBe(403);

    const wrongGrant = registerFileServeApproval({ path: h.outsideSecretPath })!;
    const forged = await h.call('POST', '/api/files/approve-serve', {
      payload: { approvalId: wrongGrant.approvalId, decision: 'approve', grant: 'not-a-grant' },
    });
    expect(forged.statusCode).toBe(403);

    const reprobe = await h.call('GET', `/api/files/serve?path=${encodeURIComponent(h.outsideSecretPath)}`);
    expect(reprobe.statusCode).toBe(403);
    expect(reprobe.body).not.toContain(OUTSIDE_SECRET_BODY);

    // The listing endpoint must not leak the grants either.
    const pending = await h.call('GET', '/api/files/pending-approvals');
    expect(pending.statusCode).toBe(200);
    expect(pending.body).not.toContain(wrongGrant.grant);
    expect(pending.body).not.toContain(registered!.grant);
  });

  it('serves an out-of-root file once a grant from the approval round-trip is presented', async () => {
    const registered = registerFileServeApproval({ path: h.outsideSecretPath })!;

    const approved = await h.call('POST', '/api/files/approve-serve', {
      payload: { approvalId: registered.approvalId, decision: 'approve', grant: registered.grant },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toEqual({ ok: true, path: h.outsideSecretPath });

    const served = await h.call('GET', `/api/files/serve?path=${encodeURIComponent(h.outsideSecretPath)}`);
    expect(served.statusCode).toBe(200);
    expect(served.body).toBe(OUTSIDE_SECRET_BODY);

    // The grant is single-use: replaying it after consumption is a 404.
    const replay = await h.call('POST', '/api/files/approve-serve', {
      payload: { approvalId: registered.approvalId, decision: 'approve', grant: registered.grant },
    });
    expect(replay.statusCode).toBe(404);
  });

  it('rejects an unknown decision verb', async () => {
    const registered = registerFileServeApproval({ path: h.outsideSecretPath })!;
    const res = await h.call('POST', '/api/files/approve-serve', {
      payload: { approvalId: registered.approvalId, decision: 'maybe', grant: registered.grant },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/files/serve — inline rendering', () => {
  it('forces html to an attachment with nosniff, with and without ?download', async () => {
    const url = `/api/files/serve?path=${encodeURIComponent(join(h.fileRoot, 'page.html'))}`;

    for (const target of [url, `${url}&download=1`]) {
      const res = await h.call('GET', target);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(String(res.headers['content-disposition'])).not.toMatch(/^inline/);
      expect(res.body).toBe(HTML_BODY);
    }
  });

  it('forces svg and js to attachments', async () => {
    const svg = await h.call('GET', `/api/files/serve?path=${encodeURIComponent(join(h.fileRoot, 'icon.svg'))}`);
    expect(svg.statusCode).toBe(200);
    expect(svg.headers['content-type']).toContain('image/svg+xml');
    expect(svg.headers['content-disposition']).toContain('attachment');
    expect(svg.headers['x-content-type-options']).toBe('nosniff');
    expect(svg.body).toBe(SVG_BODY);
  });

  it('leaves raster images inline (the media preview path) but still nosniffed', async () => {
    const res = await h.call('GET', `/api/files/serve?path=${encodeURIComponent(join(h.fileRoot, 'pic.png'))}`);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['content-disposition']).toContain('inline');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('WebUI auth on the file routes', () => {
  const protectedUrls = [
    '/api/files/tree',
    '/api/files/roots',
    '/api/files/content?path=notes.txt',
    '/api/files/download?path=notes.txt',
    '/api/files/serve?path=notes.txt',
    '/api/files/pending-approvals',
  ];

  for (const url of protectedUrls) {
    it(`401s an unauthenticated GET of ${url}`, async () => {
      const res = await h.call('GET', url, { token: null });
      expect(res.statusCode).toBe(401);
      expect(res.body).not.toContain('root file body');
    });

    it(`403s a wrong-token GET of ${url}`, async () => {
      const res = await h.call('GET', url, { token: 'wrong-token' });
      expect(res.statusCode).toBe(403);
    });
  }

  it('401s an unauthenticated approve-serve and file write', async () => {
    const registered = registerFileServeApproval({ path: h.outsideSecretPath })!;
    const approve = await h.call('POST', '/api/files/approve-serve', {
      payload: { approvalId: registered.approvalId, decision: 'approve', grant: registered.grant },
      token: null,
    });
    expect(approve.statusCode).toBe(401);

    const write = await h.call('PUT', '/api/files/content', {
      payload: { path: join(h.fileRoot, 'notes.txt'), content: 'pwned' },
      token: null,
    });
    expect(write.statusCode).toBe(401);
  });
});
