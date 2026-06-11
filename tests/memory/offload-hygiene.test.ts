import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OffloadStore } from '../../src/runtime-artifacts/offload-store';
import { OffloadHygiene } from '../../src/runtime-artifacts/offload-hygiene';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'offload-hygiene-test-'));
}

describe('OffloadHygiene', () => {
  let baseDir: string;
  let store: OffloadStore;
  let hygiene: OffloadHygiene;

  beforeEach(() => {
    baseDir = createTempDir();
    store = new OffloadStore(baseDir);
    hygiene = new OffloadHygiene(store);
  });

  afterEach(() => {
    try {
      fs.rmSync(baseDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ---------------------------------------------------------------------------
  // clean
  // ---------------------------------------------------------------------------

  describe('clean', () => {
    it('returns zeros when no expired sessions exist', () => {
      const report = hygiene.clean();

      expect(report.deletedSessions).toBe(0);
      expect(report.freedBytes).toBe(0);
      expect(report.durationMs).toBeGreaterThanOrEqual(0);
      expect(report.error).toBeUndefined();
    });

    it('deletes all expired sessions and reports freed bytes', () => {
      // Create two sessions with data
      store.writeToolResult('session-1', 1, 'shell', { cmd: 'ls' }, 'a'.repeat(100), false);
      store.writeToolResult('session-1', 2, 'file_read', {}, 'b'.repeat(50), false);
      store.writeToolResult('session-2', 1, 'http_request', {}, 'c'.repeat(200), false);

      // Set mtime to 10 days ago (past the 7-day default retention)
      const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      fs.utimesSync(path.join(baseDir, 'offload', 'session-1'), oldTime, oldTime);
      fs.utimesSync(path.join(baseDir, 'offload', 'session-2'), oldTime, oldTime);

      const report = hygiene.clean();

      expect(report.deletedSessions).toBe(2);
      expect(report.freedBytes).toBeGreaterThan(0);
      expect(report.error).toBeUndefined();

      // Verify directories are removed
      expect(fs.existsSync(path.join(baseDir, 'offload', 'session-1'))).toBe(false);
      expect(fs.existsSync(path.join(baseDir, 'offload', 'session-2'))).toBe(false);
    });

    it('only deletes expired sessions when mixed with fresh ones', () => {
      store.writeToolResult('fresh', 1, 'shell', {}, 'data', false);
      store.writeToolResult('stale', 1, 'shell', {}, 'data', false);

      // Make stale session old
      const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      fs.utimesSync(path.join(baseDir, 'offload', 'stale'), oldTime, oldTime);

      const report = hygiene.clean();

      expect(report.deletedSessions).toBe(1);
      expect(report.freedBytes).toBeGreaterThan(0);
      expect(report.error).toBeUndefined();

      // Fresh should still exist, stale should be gone
      expect(fs.existsSync(path.join(baseDir, 'offload', 'fresh'))).toBe(true);
      expect(fs.existsSync(path.join(baseDir, 'offload', 'stale'))).toBe(false);
    });

    it('handles empty baseDir (no offload directory)', () => {
      const emptyBaseDir = createTempDir();
      const emptyStore = new OffloadStore(emptyBaseDir);
      const emptyHygiene = new OffloadHygiene(emptyStore);

      const report = emptyHygiene.clean();

      expect(report.deletedSessions).toBe(0);
      expect(report.freedBytes).toBe(0);
      expect(report.error).toBeUndefined();

      // Cleanup
      fs.rmSync(emptyBaseDir, { recursive: true, force: true });
    });

    it('treats all sessions as expired when retentionDays is 0', () => {
      const shortHygiene = new OffloadHygiene(store, { retentionDays: 0 });

      store.writeToolResult('recent', 1, 'shell', {}, 'data', false);
      store.writeToolResult('old', 1, 'shell', {}, 'data', false);

      // Set directory mtime 1 second in the past so retentionDays=0
      // reliably treats them as expired. Without this, mtime can equal
      // Date.now() on fast CI runners (same-ms resolution), causing
      // now - mtimeMs > 0 to be false and 0 sessions to be deleted.
      const pastTime = new Date(Date.now() - 1000);
      fs.utimesSync(path.join(baseDir, 'offload', 'recent'), pastTime, pastTime);
      fs.utimesSync(path.join(baseDir, 'offload', 'old'), pastTime, pastTime);

      const report = shortHygiene.clean();

      expect(report.deletedSessions).toBe(2);
      expect(report.freedBytes).toBeGreaterThan(0);
    });

    it('continues deleting other sessions when one fails', () => {
      store.writeToolResult('good-session', 1, 'shell', {}, 'hello', false);
      store.writeToolResult('bad-session', 1, 'shell', {}, 'world', false);

      // Make both old
      const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      const goodDir = path.join(baseDir, 'offload', 'good-session');
      const badDir = path.join(baseDir, 'offload', 'bad-session');
      fs.utimesSync(goodDir, oldTime, oldTime);
      fs.utimesSync(badDir, oldTime, oldTime);

      // Remove all permissions from bad-session directory.
      // chmod 0o444 (read-only) does NOT prevent deletion on Linux — fs.rmSync
      // with { force: true } still removes it, so both sessions get deleted.
      // chmod 0o000 prevents readdirSync() inside _calculateDirSize(), which
      // throws EACCES, is caught by the catch block, and skips the deletion.
      fs.chmodSync(badDir, 0o000);

      const report = hygiene.clean();

      expect(report.deletedSessions).toBe(1);
      expect(report.freedBytes).toBeGreaterThan(0);
      expect(report.error).toBeTruthy();

      // good-session should be deleted, bad-session should remain
      expect(fs.existsSync(goodDir)).toBe(false);
      expect(fs.existsSync(badDir)).toBe(true);

      // Restore permissions so afterEach can clean up
      fs.chmodSync(badDir, 0o755);
    });
  });
});
