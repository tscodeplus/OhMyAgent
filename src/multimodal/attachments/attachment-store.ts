import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, resolve, join, relative, isAbsolute } from 'node:path';
import * as https from 'node:https';
import * as http from 'node:http';
import type { AttachmentRecord } from '../types.js';

export interface AttachmentIngestInput {
  sessionId: string;
  messageId: string;
  source: { kind: 'url'; url: string } | { kind: 'buffer'; buffer: Buffer; fileName?: string };
  mimeType?: string;
  fileName?: string;
  sizeBytes?: number;
}

export class AttachmentStore {
  private records = new Map<string, AttachmentRecord>();
  private cacheDir: string;

  constructor(cacheDir: string) {
    this.cacheDir = resolve(cacheDir);
    mkdirSync(this.cacheDir, { recursive: true });
  }

  async ingest(input: AttachmentIngestInput): Promise<AttachmentRecord> {
    const id = randomUUID();
    const dateDir = new Date().toISOString().slice(0, 10); // yyyy-mm-dd
    const safeSessionId = sanitizePathSegment(input.sessionId);
    const storeDir = join(this.cacheDir, safeSessionId, dateDir);
    mkdirSync(storeDir, { recursive: true });

    let buffer: Buffer;
    let fileName: string;
    let originalUrl: string;

    if (input.source.kind === 'buffer') {
      buffer = input.source.buffer;
      fileName = input.source.fileName ?? `attachment-${id}`;
      originalUrl = '';
    } else {
      const result = await this.download(input.source.url);
      buffer = result.buffer;
      fileName = result.fileName ?? (basename(new URL(input.source.url).pathname) || `attachment-${id}`);
      originalUrl = input.source.url;
    }

    // Sanitize filename (basename already applied for URL-sourced files inline)
    fileName = sanitizeFileName(fileName);

    // Write to disk
    const localPath = join(storeDir, fileName);

    // Path escape check: must be within cacheDir
    if (!isWithinRoot(resolve(localPath), this.cacheDir)) {
      throw new Error(`Path escape detected: ${localPath}`);
    }

    writeFileSync(localPath, buffer);

    const record: AttachmentRecord = {
      id,
      sessionId: input.sessionId,
      messageId: input.messageId,
      originalUrl,
      localPath,
      mimeType: input.mimeType ?? 'application/octet-stream',
      fileName,
      sizeBytes: buffer.length,
      parsed: false,
      createdAt: Date.now(),
    };

    this.records.set(id, record);
    return record;
  }

  get(id: string): AttachmentRecord | undefined {
    return this.records.get(id);
  }

  listBySession(sessionId: string): AttachmentRecord[] {
    return [...this.records.values()].filter(r => r.sessionId === sessionId);
  }

  purge(sessionId: string): number {
    let count = 0;
    for (const [id, record] of this.records) {
      if (record.sessionId === sessionId) {
        this.records.delete(id);
        count++;
      }
    }
    return count;
  }

  private download(url: string): Promise<{ buffer: Buffer; fileName?: string }> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        reject(new Error(`Unsupported attachment URL protocol: ${parsed.protocol}`));
        return;
      }
      const mod = parsed.protocol === 'https:' ? https : http;
      mod.get(url, { timeout: 30_000 }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({ buffer: Buffer.concat(chunks) });
        });
      }).on('error', reject).on('timeout', function (this: any) {
        this.destroy();
        reject(new Error('Download timeout'));
      });
    });
  }
}

function sanitizePathSegment(value: string): string {
  const sanitized = basename(value).replace(/[<>:"/\\|?*\x00]/g, '_');
  return sanitized || 'attachment';
}

function sanitizeFileName(value: string): string {
  const sanitized = value.replace(/[<>:"/\\|?*\x00]/g, '_');
  return sanitized || 'attachment';
}

function isWithinRoot(filePath: string, root: string): boolean {
  const rel = relative(root, filePath);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}
