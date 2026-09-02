import { resolve } from 'node:path';
import type { AttachmentRecord, AttachmentSecurityCheck } from '../types.js';
import { isWithinRoot } from '../../shared/path-utils.js';
import { resolveAgentPath } from '../../shared/agent-home.js';

export class AttachmentSecurity {
  private cacheDir: string;

  constructor(config: { cacheDir: string }) {
    this.cacheDir = resolveAgentPath(config.cacheDir);
  }

  validate(record: AttachmentRecord): AttachmentSecurityCheck {
    // Path escape check
    const resolved = resolve(record.localPath);
    if (!isWithinRoot(resolved, this.cacheDir)) {
      return { passed: false, reason: `Path escapes cache directory: ${record.localPath}`, resolvedPath: resolved };
    }

    // Null byte in filename
    if (record.fileName.includes('\x00')) {
      return { passed: false, reason: 'Filename contains null byte', resolvedPath: resolved };
    }

    // Size check (max 50MB)
    if (record.sizeBytes > 50 * 1024 * 1024) {
      return { passed: false, reason: `File too large: ${record.sizeBytes} bytes (max 50MB)`, resolvedPath: resolved };
    }

    return { passed: true, resolvedPath: resolved };
  }
}
