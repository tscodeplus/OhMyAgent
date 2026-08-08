// ---------------------------------------------------------------------------
// Tests for session-routes persisted-URL refresh
//
// Images and files persisted as /dl/<token> links must be re-signed with the
// current key on read, so history stays downloadable across restarts (the
// signing key changes per process start). Missing files / non-/dl/ URLs must
// be left untouched.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refreshPersistedDownloadUrls } from '../../../src/app/webui/session-routes.js';
import { createDownloadUrl, verifyDownloadToken } from '../../../src/shared/download-token.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'session-routes-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('refreshPersistedDownloadUrls', () => {
  it('re-signs /dl/ image URLs and verifies with the current key', () => {
    const file = join(tmpDir, 'img.png');
    writeFileSync(file, 'bytes');
    const oldUrl = createDownloadUrl(file, 'img.png', undefined, -1000); // expired

    const images: Array<{ url: string }> = [{ url: oldUrl }];
    const files: Array<{ path: string }> = [];
    refreshPersistedDownloadUrls(images, files);

    expect(images[0].url).not.toBe(oldUrl);
    expect(images[0].url.startsWith('/dl/')).toBe(true);
    const token = images[0].url.split('/')[2] ?? '';
    expect(verifyDownloadToken(token)?.filePath).toBe(file);
  });

  it('re-signs /dl/ file URLs too', () => {
    const file = join(tmpDir, 'doc.txt');
    writeFileSync(file, 'hello');
    const oldUrl = createDownloadUrl(file, 'doc.txt', undefined, -1000);

    const images: Array<{ url: string }> = [];
    const files: Array<{ path: string }> = [{ path: oldUrl }];
    refreshPersistedDownloadUrls(images, files);

    expect(files[0].path).not.toBe(oldUrl);
    expect(verifyDownloadToken(files[0].path.split('/')[2] ?? '')?.filePath).toBe(file);
  });

  it('leaves non-/dl/ URLs untouched', () => {
    const serveUrl = `/api/files/serve?path=${encodeURIComponent(join(tmpDir, 'img.png'))}`;
    const images: Array<{ url: string }> = [{ url: serveUrl }];
    const files: Array<{ path: string }> = [{ path: serveUrl }];
    refreshPersistedDownloadUrls(images, files);

    expect(images[0].url).toBe(serveUrl);
    expect(files[0].path).toBe(serveUrl);
  });

  it('leaves /dl/ URLs pointing at missing files untouched', () => {
    const missing = join(tmpDir, 'gone.png');
    const oldUrl = createDownloadUrl(missing, 'gone.png');

    const images: Array<{ url: string }> = [{ url: oldUrl }];
    refreshPersistedDownloadUrls(images, []);

    expect(images[0].url).toBe(oldUrl);
  });
});
