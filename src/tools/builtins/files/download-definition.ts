// ---------------------------------------------------------------------------
// v4 ToolDefinition for the download_file tool
//
// Downloads a file from an HTTP/HTTPS URL and saves it to data/downloads/.
// Returns the local path and a public download URL suitable for sharing
// across all channels (Feishu, Telegram, WeChat, QQ, WebUI).
//
// Security:
// - Only HTTP/HTTPS URLs are allowed
// - Downloaded files are saved under data/downloads/
// - Path traversal in filename is sanitized
// - 50 MB size limit
// ---------------------------------------------------------------------------

import { Type } from 'typebox';
import path from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as https from 'node:https';
import * as http from 'node:http';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { textResult, errorResult } from '../../platform/tool-result.js';
import { createDownloadUrl } from '../../../shared/download-token.js';

export const downloadFileCapability: ToolCapabilityDescriptor = {
  category: 'file',
  readOnly: false,       // writes the downloaded file to disk
  readsFiles: false,
  writesFiles: true,
  usesShell: false,
  usesNetwork: true,     // makes HTTP(S) requests
  usesComputerUse: false,
  pathAccess: 'write',
  approvalDefault: 'none',
};

const DOWNLOADS_DIR = path.resolve(process.cwd(), 'data', 'downloads');
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

function sanitizeFileName(value: string): string {
  // Remove path separators and null bytes
  const sanitized = path.basename(value).replace(/[<>:"/\\|?*\x00]/g, '_');
  return sanitized || 'download';
}

function downloadFromUrl(url: string): Promise<{ buffer: Buffer; contentType?: string; fileName?: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      rejectPromise(new Error(`Unsupported URL protocol: ${parsed.protocol}`));
      return;
    }

    const mod = parsed.protocol === 'https:' ? https : http;

    // Handle redirects (max 5)
    const maxRedirects = 5;
    let redirectCount = 0;

    function makeRequest(requestUrl: string) {
      mod.get(requestUrl, { timeout: 60_000 }, (res) => {
        // Follow redirects
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          redirectCount++;
          if (redirectCount > maxRedirects) {
            rejectPromise(new Error('Too many redirects'));
            return;
          }
          const location = res.headers.location;
          const redirectUrl = location.startsWith('http')
            ? location
            : new URL(location, parsed.origin).href;
          // Consume response and follow
          res.resume();
          makeRequest(redirectUrl);
          return;
        }

        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          rejectPromise(new Error(`HTTP ${res.statusCode}: ${res.statusMessage || 'Request failed'}`));
          return;
        }

        // Check Content-Length before downloading
        const contentLengthStr = res.headers['content-length'];
        if (contentLengthStr) {
          const contentLength = parseInt(contentLengthStr, 10);
          if (contentLength > MAX_FILE_SIZE) {
            res.destroy();
            rejectPromise(new Error(
              `File too large: ${(contentLength / 1024 / 1024).toFixed(1)} MB (max 50 MB)`,
            ));
            return;
          }
        }

        const chunks: Buffer[] = [];
        let totalSize = 0;

        res.on('data', (chunk: Buffer) => {
          totalSize += chunk.length;
          if (totalSize > MAX_FILE_SIZE) {
            res.destroy();
            rejectPromise(new Error(
              `Download exceeded size limit (50 MB)`,
            ));
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const contentType = res.headers['content-type'] || undefined;

          // Extract filename from Content-Disposition header
          let fileName: string | undefined;
          const disposition = res.headers['content-disposition'];
          if (typeof disposition === 'string') {
            const match = disposition.match(/filename\*?=(?:(['"])(.*?)\1|([^;\n]*))/i);
            if (match) {
              fileName = (match[2] || match[3] || '').replace(/['"]/g, '');
            }
          }

          resolvePromise({ buffer, contentType, fileName });
        });

        res.on('error', (err) => {
          rejectPromise(err);
        });
      }).on('error', (err) => {
        rejectPromise(err);
      }).on('timeout', function (this: any) {
        this.destroy();
        rejectPromise(new Error('Download timeout (60s)'));
      });
    }

    makeRequest(url);
  });
}

function getBaseUrl(): string | undefined {
  return process.env.OHMYAGENT_PUBLIC_URL || undefined;
}

export function createDownloadFileToolDefinition(): ToolDefinition {
  // Ensure downloads directory exists
  if (!existsSync(DOWNLOADS_DIR)) {
    mkdirSync(DOWNLOADS_DIR, { recursive: true });
  }

  return {
    name: 'download_file',
    label: 'Download File',
    description:
      'Download a file from an HTTP/HTTPS URL and save it locally. ' +
      'Use this tool when you need to fetch external resources (documents, ' +
      'archives, etc.) that users reference by URL. Returns the local file path ' +
      'and a public download URL that can be shared across all channels.',
    category: 'file',
    parametersSchema: Type.Object({
      url: Type.String({
        description: 'The HTTP or HTTPS URL of the file to download',
      }),
      filename: Type.Optional(Type.String({
        description: 'Optional filename to save as (sanitized automatically). If omitted, derived from URL or Content-Disposition header.',
      })),
    }),
    capability: downloadFileCapability,
    execute: async (
      args: { url: string; filename?: string },
      _ctx,
    ) => {
      try {
        const { url, filename: suggestedName } = args;

        // Validate URL
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return errorResult('Invalid URL. Please provide a valid HTTP or HTTPS URL.');
        }

        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return errorResult(
            `Unsupported URL protocol "${parsed.protocol}". Only HTTP and HTTPS URLs are supported.`,
          );
        }

        // Download the file
        const result = await downloadFromUrl(url);

        // Determine filename
        const rawFileName = suggestedName
          || result.fileName
          || path.basename(parsed.pathname)
          || 'download';
        const fileName = sanitizeFileName(rawFileName);

        // Ensure unique filename
        let destPath = path.join(DOWNLOADS_DIR, fileName);
        if (existsSync(destPath)) {
          const ext = path.extname(fileName);
          const base = path.basename(fileName, ext);
          const uniqueSuffix = `_${Date.now()}_${randomUUID().slice(0, 8)}`;
          destPath = path.join(DOWNLOADS_DIR, `${base}${uniqueSuffix}${ext}`);
        }

        // Write file
        writeFileSync(destPath, result.buffer);

        // Generate public download URL (full URL when OHMYAGENT_PUBLIC_URL is configured)
        const downloadUrl = createDownloadUrl(destPath, fileName, getBaseUrl());

        const sizeStr = result.buffer.length < 1024
          ? `${result.buffer.length} B`
          : result.buffer.length < 1024 * 1024
            ? `${(result.buffer.length / 1024).toFixed(1)} KB`
            : `${(result.buffer.length / (1024 * 1024)).toFixed(1)} MB`;

        return textResult(
          `✅ 文件下载成功\n` +
          `- 文件名: ${fileName}\n` +
          `- 大小: ${sizeStr}\n` +
          `- 本地路径: ${destPath}\n` +
          `- 下载链接: ${downloadUrl}\n\n` +
          `你可以使用 file_read 工具读取此文件的内容。`,
          { localPath: destPath, fileName, size: result.buffer.length, downloadUrl },
        );
      } catch (err: any) {
        const message = err.message ?? String(err);
        return errorResult(`文件下载失败: ${message}`);
      }
    },
  };
}
