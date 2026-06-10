import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { MediaParseResult } from '../types.js';

export class DocumentParser {
  async extract(filePath: string, mimeType: string): Promise<MediaParseResult> {
    const stat = statSync(filePath);
    const name = basename(filePath);
    const ext = name.split('.').pop()?.toLowerCase() ?? '';

    // Text-based files: read directly
    if (['txt', 'md', 'json', 'xml', 'csv', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'env', 'log', 'html', 'css', 'js', 'ts', 'py', 'sh', 'sql'].includes(ext)) {
      try {
        const text = readFileSync(filePath, 'utf-8');
        const truncated = text.length > 50_000 ? text.slice(0, 50_000) + '\n\n[... content truncated ...]' : text;
        return { kind: 'document', text: truncated, metadata: { size: stat.size, mimeType } };
      } catch {
        return this.fallback(name, mimeType, stat.size);
      }
    }

    // PDF: try regex text extraction from raw bytes
    if (ext === 'pdf') {
      return this.fallback(name, mimeType, stat.size);
    }

    // Office documents: return description only (no parsing in Phase 4)
    if (['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt'].includes(ext)) {
      return { kind: 'document', text: `[Office document: ${name}, type: ${mimeType}, size: ${stat.size} bytes]`, metadata: { size: stat.size, mimeType } };
    }

    return this.fallback(name, mimeType, stat.size);
  }

  private fallback(name: string, mimeType: string, size: number): MediaParseResult {
    return {
      kind: 'document',
      text: `[Document: ${name}, type: ${mimeType}, size: ${size} bytes]`,
      metadata: { size, mimeType },
    };
  }
}
