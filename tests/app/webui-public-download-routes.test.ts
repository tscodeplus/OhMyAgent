/**
 * Regression tests for the signed download route (GET /dl/:token/:filename).
 *
 * Two things are pinned here:
 *   - the `config: { skipAuth: true }` route option that was deleted was inert —
 *     webuiAuthHook matches URL prefixes only and has no /dl exemption, so the
 *     route really has always required a bearer token. If someone wires
 *     skipAuth up (or adds /dl to PUBLIC_PREFIXES) without thinking about it,
 *     this test fails and the decision becomes visible.
 *   - SVG/HTML must not be rendered inline by the browser.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFilesHarness, SVG_BODY, type FilesHarness } from './webui-files-harness.js';
import { generateDownloadToken } from '../../src/shared/download-token.js';

let h: FilesHarness;
let dlDir: string;

beforeEach(async () => {
  h = await createFilesHarness();
  // /tmp is one of the route's allowed roots.
  dlDir = mkdtempSync(join(tmpdir(), 'oma-dl-'));
});

afterEach(async () => {
  await h.cleanup();
  rmSync(dlDir, { recursive: true, force: true });
});

function dlUrl(filePath: string, filename = 'file') {
  return `/dl/${generateDownloadToken(filePath)}/${encodeURIComponent(filename)}`;
}

describe('GET /dl/:token/:filename', () => {
  it('requires WebUI auth — the deleted skipAuth route option was never read', async () => {
    writeFileSync(join(dlDir, 'pic.png'), 'png bytes');
    const url = dlUrl(join(dlDir, 'pic.png'), 'pic.png');

    const anonymous = await h.app.inject({ method: 'GET', url });
    expect(anonymous.statusCode).toBe(401);

    const authed = await h.call('GET', url);
    expect(authed.statusCode).toBe(200);
  });

  it('serves svg as an attachment with nosniff, never inline', async () => {
    writeFileSync(join(dlDir, 'icon.svg'), SVG_BODY);
    const res = await h.call('GET', dlUrl(join(dlDir, 'icon.svg'), 'icon.svg'));

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
    expect(String(res.headers['content-disposition'])).toContain('attachment');
    expect(String(res.headers['content-disposition'])).not.toMatch(/^inline/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('keeps raster images inline', async () => {
    writeFileSync(join(dlDir, 'pic.png'), 'png bytes');
    const res = await h.call('GET', dlUrl(join(dlDir, 'pic.png'), 'pic.png'));

    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-disposition'])).toContain('inline');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('rejects a signed path outside the allowed roots and a tampered token', async () => {
    const outside = join(h.outsideDir, 'secret.txt');
    writeFileSync(outside, 'outside bytes');

    const res = await h.call('GET', dlUrl(outside, 'secret.txt'));
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('outside bytes');

    writeFileSync(join(dlDir, 'pic.png'), 'png bytes');
    const token = generateDownloadToken(join(dlDir, 'pic.png'));
    const valid = dlUrl(join(dlDir, 'pic.png'), 'pic.png');
    expect((await h.call('GET', valid)).statusCode).toBe(200);

    // Flip the last signature character (to a different one — a no-op mutation
    // would make this assertion vacuous).
    const flipped = token.endsWith('a') ? 'b' : 'a';
    const bad = await h.call('GET', `/dl/${token.slice(0, -1)}${flipped}/pic.png`);
    expect(bad.statusCode).toBe(403);
  });
});
