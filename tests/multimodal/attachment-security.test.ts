import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AttachmentSecurity } from '../../src/multimodal/attachments/attachment-security.js';
import type { AttachmentRecord } from '../../src/multimodal/types.js';

function makeRecord(overrides: Partial<AttachmentRecord> = {}): AttachmentRecord {
  return {
    id: 'test-id',
    sessionId: 'session-1',
    messageId: 'msg-1',
    originalUrl: '',
    localPath: '/tmp/test-file.txt',
    mimeType: 'text/plain',
    fileName: 'test-file.txt',
    sizeBytes: 100,
    parsed: false,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('AttachmentSecurity', () => {
  const cacheDir = resolve('/tmp/ohmyagent-cache-test');
  let security: AttachmentSecurity;

  beforeEach(() => {
    mkdirSync(cacheDir, { recursive: true });
    security = new AttachmentSecurity({ cacheDir });
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  describe('validate', () => {
    it('should pass for a valid record within cache dir', () => {
      const record = makeRecord({ localPath: join(cacheDir, 'valid-file.txt') });
      const result = security.validate(record);
      expect(result.passed).toBe(true);
      expect(result.reason).toBeUndefined();
      expect(result.resolvedPath).toBe(join(cacheDir, 'valid-file.txt'));
    });

    it('should reject a record with path escaping ../', () => {
      const record = makeRecord({
        localPath: join(cacheDir, '..', 'etc', 'passwd'),
      });
      const result = security.validate(record);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('Path escapes cache directory');
    });

    it('should reject a record with absolute path outside cache dir', () => {
      const record = makeRecord({
        localPath: '/etc/passwd',
      });
      const result = security.validate(record);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('Path escapes cache directory');
    });

    it('should reject a sibling path that shares the cache dir prefix', () => {
      const record = makeRecord({
        localPath: `${cacheDir}-sibling/file.txt`,
      });
      const result = security.validate(record);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('Path escapes cache directory');
    });

    it('should reject a record with null byte in filename', () => {
      const record = makeRecord({
        fileName: 'malicious.txt\x00.exe',
        localPath: join(cacheDir, 'malicious.txt\x00.exe'),
      });
      const result = security.validate(record);
      expect(result.passed).toBe(false);
      expect(result.reason).toBe('Filename contains null byte');
    });

    it('should reject a record larger than 50MB', () => {
      const record = makeRecord({
        sizeBytes: 51 * 1024 * 1024,
        localPath: join(cacheDir, 'huge-file.bin'),
      });
      const result = security.validate(record);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('50MB');
    });

    it('should pass for a record exactly at 50MB boundary', () => {
      const record = makeRecord({
        sizeBytes: 50 * 1024 * 1024,
        localPath: join(cacheDir, 'at-limit.bin'),
      });
      const result = security.validate(record);
      expect(result.passed).toBe(true);
    });

    it('should pass for a nested path within cache dir', () => {
      const record = makeRecord({
        localPath: join(cacheDir, 'subdir', 'nested', 'file.txt'),
      });
      const result = security.validate(record);
      expect(result.passed).toBe(true);
    });
  });
});
