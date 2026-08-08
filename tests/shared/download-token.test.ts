// ---------------------------------------------------------------------------
// Tests for download-token signing, persistent secret and URL refresh
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateDownloadToken,
  verifyDownloadToken,
  createDownloadUrl,
  refreshDownloadUrl,
  resetDownloadSecret,
} from '../../src/shared/download-token.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'download-token-test-'));
});

afterEach(() => {
  delete process.env.OHMYAGENT_DOWNLOAD_SECRET;
  delete process.env.OHMYAGENT_DOWNLOAD_SECRET_FILE;
  delete process.env.FEISHU_APP_SECRET;
  resetDownloadSecret();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('download-token secret persistence', () => {
  it('persists a generated secret to disk and reuses it across "restarts"', () => {
    const secretFile = join(tmpDir, 'secret');
    process.env.OHMYAGENT_DOWNLOAD_SECRET_FILE = secretFile;

    // First "process": secret file is created
    resetDownloadSecret();
    const tokenA = generateDownloadToken('/tmp/fake.png');

    expect(existsSync(secretFile)).toBe(true);
    const persisted = readFileSync(secretFile, 'utf-8').trim();
    expect(persisted.length).toBeGreaterThan(0);

    // Second "process" (cache reset): same key on disk is reused, so the
    // previously signed token still verifies.
    resetDownloadSecret();
    const tokenB = generateDownloadToken('/tmp/fake.png');

    expect(verifyDownloadToken(tokenA)).not.toBeNull();
    expect(verifyDownloadToken(tokenB)).not.toBeNull();
  });

  it('uses a different key per secret file (tokens invalidated across files)', () => {
    const secretFileA = join(tmpDir, 'secret-a');
    const secretFileB = join(tmpDir, 'secret-b');

    process.env.OHMYAGENT_DOWNLOAD_SECRET_FILE = secretFileA;
    resetDownloadSecret();
    const tokenA = generateDownloadToken('/tmp/fake.png');

    // Switch to another file → different key → old token no longer verifies
    process.env.OHMYAGENT_DOWNLOAD_SECRET_FILE = secretFileB;
    resetDownloadSecret();
    expect(verifyDownloadToken(tokenA)).toBeNull();

    // Switch back → key restored → old token verifies again
    process.env.OHMYAGENT_DOWNLOAD_SECRET_FILE = secretFileA;
    resetDownloadSecret();
    expect(verifyDownloadToken(tokenA)).not.toBeNull();
  });

  it('prefers the explicit env secret over the persisted file', () => {
    process.env.OHMYAGENT_DOWNLOAD_SECRET = 'fixed-env-secret';
    resetDownloadSecret();
    const token = generateDownloadToken('/tmp/fake.png');

    // Remove the env secret and point the file fallback elsewhere:
    // the env-signed token must NOT verify with the file key.
    delete process.env.OHMYAGENT_DOWNLOAD_SECRET;
    process.env.OHMYAGENT_DOWNLOAD_SECRET_FILE = join(tmpDir, 'secret');
    resetDownloadSecret();
    expect(verifyDownloadToken(token)).toBeNull();
  });

  it('falls back to a per-process random key when the file cannot be written', () => {
    process.env.OHMYAGENT_DOWNLOAD_SECRET_FILE = join(tmpDir, 'no-such-dir', 'nested', 'secret');
    resetDownloadSecret();
    const token = generateDownloadToken('/tmp/fake.png');
    expect(verifyDownloadToken(token)).not.toBeNull();
  });
});

describe('refreshDownloadUrl', () => {
  it('refreshes an expired token for an existing file', () => {
    const file = join(tmpDir, 'photo.png');
    writeFileSync(file, Buffer.from('png-bytes'));

    // Token that expired 1 second ago (negative TTL)
    const expiredUrl = createDownloadUrl(file, 'photo.png', undefined, -1000);
    const tokenPart = expiredUrl.split('/')[2] ?? '';
    expect(verifyDownloadToken(tokenPart)).toBeNull(); // expired

    const refreshed = refreshDownloadUrl(expiredUrl);
    expect(refreshed).not.toBeNull();

    const newToken = refreshed!.split('/')[2] ?? '';
    const decoded = verifyDownloadToken(newToken);
    expect(decoded?.filePath).toBe(file);
  });

  it('returns null for a missing file', () => {
    const missing = join(tmpDir, 'does-not-exist.png');
    const url = createDownloadUrl(missing, 'does-not-exist.png');
    expect(refreshDownloadUrl(url)).toBeNull();
  });

  it('returns null for a malformed URL', () => {
    expect(refreshDownloadUrl('/dl/not-a-token/name.png')).toBeNull();
  });
});
