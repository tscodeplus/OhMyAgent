import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OffloadStore, OffloadRecord } from '../../src/runtime-artifacts/offload-store';

/**
 * Helper: create a unique temporary directory for each test suite run.
 */
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'offload-store-test-'));
}

describe('OffloadStore', () => {
  let baseDir: string;
  let store: OffloadStore;

  beforeEach(() => {
    baseDir = createTempDir();
    store = new OffloadStore(baseDir);
  });

  afterEach(() => {
    // Best-effort cleanup of the entire temporary tree.
    try {
      fs.rmSync(baseDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ---------------------------------------------------------------------------
  // writeToolResult
  // ---------------------------------------------------------------------------

  describe('writeToolResult', () => {
    it('creates session directory, .md file, and offload.jsonl', () => {
      const record = store.writeToolResult('session-1', 1, 'shell', { cmd: 'ls -la' }, 'total 42\n-rw-r--r-- 1 user user 100 file.txt\n', false);

      // Returns correct OffloadRecord
      expect(record.seq).toBe(1);
      expect(record.toolName).toBe('shell');
      expect(record.toolArgs).toEqual({ cmd: 'ls -la' });
      expect(record.refPath).toBe('001-shell.md');
      expect(record.nodeId).toBe('node-001');
      expect(record.status).toBe('success');
      expect(record.summary).toBe('');
      expect(typeof record.timestamp).toBe('number');

      // Session directory exists
      const sessionDir = path.join(baseDir, 'offload', 'session-1');
      expect(fs.existsSync(sessionDir)).toBe(true);

      // offload.jsonl exists with one line
      const jsonlPath = path.join(sessionDir, 'offload.jsonl');
      expect(fs.existsSync(jsonlPath)).toBe(true);
      const lines = fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]) as OffloadRecord;
      expect(parsed.seq).toBe(1);
      expect(parsed.refPath).toBe('001-shell.md');

      // .md file exists with content wrapped in fenced code block
      const mdPath = path.join(sessionDir, '001-shell.md');
      expect(fs.existsSync(mdPath)).toBe(true);
      const mdContent = fs.readFileSync(mdPath, 'utf-8');
      expect(mdContent).toContain('```');
      expect(mdContent).toContain('total 42');
    });

    it('writes result object as JSON string', () => {
      const record = store.writeToolResult('session-2', 1, 'http_request', { url: 'https://example.com' }, { statusCode: 200, body: 'ok' }, false);
      const mdContent = fs.readFileSync(path.join(baseDir, 'offload', 'session-2', record.refPath), 'utf-8');
      expect(mdContent).toContain('"statusCode": 200');
    });

    it('marks error status when isError is true', () => {
      const record = store.writeToolResult('session-e', 1, 'shell', { cmd: 'rm /nonexistent' }, 'Error: ENOENT: no such file', true);
      expect(record.status).toBe('error');
    });

    it('persists the summary in offload.jsonl', () => {
      store.writeToolResult('summary-session', 1, 'shell', { cmd: 'pwd' }, 'ok', false, '执行 pwd');

      const records = store.getSessionRecords('summary-session');
      expect(records[0].summary).toBe('执行 pwd');
    });

    it('sanitizes session and tool names before writing paths', () => {
      const record = store.writeToolResult('../bad/session', 1, '../shell/tool', {}, 'ok', false);

      expect(record.refPath).toBe('001-shell_tool.md');
      expect(fs.existsSync(path.join(baseDir, 'offload', 'bad_session', record.refPath))).toBe(true);
      expect(fs.existsSync(path.join(baseDir, 'bad'))).toBe(false);
    });

    it('generates zero-padded nodeId for double-digit seq', () => {
      const record = store.writeToolResult('s', 42, 'file_read', { path: '/foo' }, 'content', false);
      expect(record.nodeId).toBe('node-042');
      expect(record.refPath).toBe('042-file_read.md');
    });
  });

  // ---------------------------------------------------------------------------
  // getSessionRecords
  // ---------------------------------------------------------------------------

  describe('getSessionRecords', () => {
    it('returns empty array for non-existent session', () => {
      const records = store.getSessionRecords('nonexistent');
      expect(records).toEqual([]);
    });

    it('returns all records in insertion order', () => {
      store.writeToolResult('seq-session', 1, 'shell', { cmd: 'echo 1' }, 'output1', false);
      store.writeToolResult('seq-session', 2, 'file_read', { path: '/a' }, 'content2', false);
      store.writeToolResult('seq-session', 3, 'http_request', {}, 'result3', true);

      const records = store.getSessionRecords('seq-session');
      expect(records).toHaveLength(3);
      expect(records[0].seq).toBe(1);
      expect(records[1].seq).toBe(2);
      expect(records[2].seq).toBe(3);
      expect(records[2].status).toBe('error');
    });
  });

  // ---------------------------------------------------------------------------
  // getFullResult
  // ---------------------------------------------------------------------------

  describe('getFullResult', () => {
    it('returns the exact content written', () => {
      const expectedResult = 'line1\nline2\nline3\n';
      store.writeToolResult('r-session', 1, 'shell', { cmd: 'echo hi' }, expectedResult, false);

      const content = store.getFullResult('r-session', '001-shell.md');
      expect(content).toBe('```\n' + expectedResult + '\n```\n');
    });

    it('throws when refPath does not exist', () => {
      expect(() => store.getFullResult('r-session', '999-missing.md')).toThrow();
    });

    it('rejects refPath traversal outside the session directory', () => {
      store.writeToolResult('safe-session', 1, 'shell', {}, 'ok', false);

      expect(() => store.getFullResult('safe-session', '../escape.md')).toThrow('Path escapes offload root');
    });
  });

  // ---------------------------------------------------------------------------
  // deleteSession
  // ---------------------------------------------------------------------------

  describe('deleteSession', () => {
    it('removes the entire session directory', () => {
      store.writeToolResult('del-session', 1, 'shell', {}, 'data', false);
      const sessionDir = path.join(baseDir, 'offload', 'del-session');
      expect(fs.existsSync(sessionDir)).toBe(true);

      store.deleteSession('del-session');
      expect(fs.existsSync(sessionDir)).toBe(false);
    });

    it('does not throw when session does not exist', () => {
      expect(() => store.deleteSession('ghost')).not.toThrow();
    });

    it('deletes legacy unsanitized session directories returned by directory scans', () => {
      const legacyDir = path.join(baseDir, 'offload', 'group-chat:thread-1');
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(path.join(legacyDir, 'offload.jsonl'), '', 'utf-8');

      store.deleteSession('group-chat:thread-1');

      expect(fs.existsSync(legacyDir)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // listExpiredSessions
  // ---------------------------------------------------------------------------

  describe('listExpiredSessions', () => {
    it('returns empty list when no sessions exist', () => {
      expect(store.listExpiredSessions(7)).toEqual([]);
    });

    it('returns expired session names based on mtime', () => {
      // Write two sessions, then manually set mtime on one to simulate age.
      store.writeToolResult('fresh', 1, 'shell', {}, 'a', false);
      store.writeToolResult('stale', 1, 'shell', {}, 'b', false);

      const staleDir = path.join(baseDir, 'offload', 'stale');
      const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago
      fs.utimesSync(staleDir, oldTime, oldTime);

      // retentionDays = 7 → stale is expired, fresh is not
      const expired = store.listExpiredSessions(7);
      expect(expired).toContain('stale');
      expect(expired).not.toContain('fresh');
    });
  });

  // ---------------------------------------------------------------------------
  // countTokens
  // ---------------------------------------------------------------------------

  describe('countTokens', () => {
    it('returns 0 for empty list', () => {
      expect(store.countTokens([])).toBe(0);
    });

    it('returns a positive integer for non-empty records', () => {
      const records: OffloadRecord[] = [
        {
          seq: 1,
          toolName: 'shell',
          toolArgs: { cmd: 'echo hello' },
          refPath: '001-shell.md',
          timestamp: 1712345678000,
          nodeId: 'node-001',
          summary: 'some summary',
          status: 'success',
        },
      ];
      const tokens = store.countTokens(records);
      expect(tokens).toBeGreaterThan(0);
      expect(Number.isInteger(tokens)).toBe(true);
    });

    it('approximate token count scales with record size', () => {
      const small: OffloadRecord[] = [
        { seq: 1, toolName: 'x', toolArgs: {}, refPath: 'a.md', timestamp: 1, nodeId: 'node-001', summary: '', status: 'success' },
      ];
      const large: OffloadRecord[] = [
        { seq: 1, toolName: 'x', toolArgs: {}, refPath: 'a.md', timestamp: 1, nodeId: 'node-001', summary: 'x'.repeat(500), status: 'success' },
      ];
      expect(store.countTokens(large)).toBeGreaterThan(store.countTokens(small));
    });
  });
});
