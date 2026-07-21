/**
 * WebUI send_media tool.
 *
 * Allows the agent to send images and files directly in the WebUI chat by
 * returning serve URLs that the frontend renders as image thumbnails or
 * file download links. Uses public download tokens (/dl/:token/:filename)
 * so the links work across all channels without authentication.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Type } from 'typebox';
import type { AgentTool } from '../../../pi-mono/agent/types.js';
import { shouldRouteToDesktopBridge } from '../../platform/tool-context.js';
import { createDownloadUrl } from '../../../shared/download-token.js';

function getBaseUrl(): string | undefined {
  return process.env.OHMYAGENT_PUBLIC_URL || undefined;
}
interface SendMediaDetails {
  filePath: string;
  fileName: string;
  size: number;
  serveUrl: string;
}

// Same allowed roots as the /api/files/serve endpoint
function getAllowedRoots(): string[] {
  return [
    process.cwd(),
    '/tmp',
    os.homedir(),
  ];
}

function isPathAllowed(filePath: string, allowedRoots: string[]): boolean {
  const resolved = path.resolve(filePath);
  for (const root of allowedRoots) {
    const resolvedRoot = path.resolve(root);
    if (resolved.startsWith(resolvedRoot + path.sep) || resolved === resolvedRoot) {
      return true;
    }
  }
  return false;
}

function isImageExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'].includes(ext);
}

function isVideoExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ['.mp4', '.webm', '.mov', '.avi', '.mkv'].includes(ext);
}

export function createSendMediaTool(): AgentTool<any> {
  const allowedRoots = getAllowedRoots();

  return {
    name: 'webui_send_media',
    label: 'Send Media to Chat (WebUI)',
    description:
      'Send an image, video, or file from the local filesystem to the chat. ' +
      'Provide an absolute file path. The file will be displayed inline (images) ' +
      'or as a download link (other files).',
    parameters: Type.Object({
      filePath: Type.String({
        description: 'Absolute path of the file to send (image, video, or document)',
      }),
    }),
    execute: async (_toolCallId: string, rawParams: unknown) => {
      try {
        const params = rawParams as { filePath: string };
        const rawPath = params.filePath;

        // ── Desktop Bridge path (check BEFORE path.resolve — Windows paths
        //     like E:\test.txt get mangled by path.resolve on Linux) ──
        // Only route to desktop bridge if the file does NOT exist locally.
        // On WSL, /home/ paths are local and should be served directly via /dl/ URLs.
        if (shouldRouteToDesktopBridge(rawPath) && !fs.existsSync(rawPath)) {
          const fileName = path.basename(rawPath);
          const serveUrl = `/desktop-bridge-download?path=${encodeURIComponent(rawPath)}&name=${encodeURIComponent(fileName)}`;

          if (isImageExtension(fileName) || isVideoExtension(fileName)) {
            return {
              content: [{ type: 'text' as const, text: `Sent file from desktop: ${fileName}\n\nDownload: [${fileName}](${serveUrl})` }],
              details: { filePath: rawPath, fileName, size: -1, serveUrl },
            };
          }
          return {
            content: [{ type: 'text' as const, text: `Sent file from desktop: ${fileName}\n\nDownload: [${fileName}](${serveUrl})` }],
            details: { filePath: rawPath, fileName, size: -1, serveUrl },
          };
        }

        // Resolve to absolute path (expand ~)
        let filePath: string;
        if (rawPath.startsWith('~')) {
          filePath = path.resolve(os.homedir(), rawPath.slice(rawPath.startsWith('~/') ? 2 : 1));
        } else {
          filePath = path.resolve(rawPath);
        }

        // ── Gateway-local path ──
        // Check if file exists
        if (!fs.existsSync(filePath)) {
          throw new Error(`File not found: ${filePath}`);
        }

        // Check if it's a file (not directory)
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          throw new Error(`Path is a directory, not a file: ${filePath}`);
        }

        // Check size limit (50 MB)
        const maxSize = 50 * 1024 * 1024;
        if (stat.size > maxSize) {
          throw new Error(`File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB, max 50 MB)`);
        }

        // Check path is within allowed roots
        if (!isPathAllowed(filePath, allowedRoots)) {
          throw new Error(
            `File path is outside allowed directories. Allowed roots: ${allowedRoots.join(', ')}. ` +
            `Use the file path directly in your response with the serve URL format.`,
          );
        }

        const fileName = path.basename(filePath);
        const serveUrl = createDownloadUrl(filePath, fileName, getBaseUrl());
        const sizeStr = stat.size < 1024
          ? `${stat.size} B`
          : stat.size < 1024 * 1024
            ? `${(stat.size / 1024).toFixed(1)} KB`
            : `${(stat.size / (1024 * 1024)).toFixed(1)} MB`;

        const details: SendMediaDetails = { filePath, fileName, size: stat.size, serveUrl };

        if (isImageExtension(fileName)) {
          return {
            content: [{ type: 'text' as const, text: `Sent image: ${fileName} (${sizeStr})\n\n![${fileName}](${serveUrl})` }],
            details,
          };
        }

        if (isVideoExtension(fileName)) {
          return {
            content: [{ type: 'text' as const, text: `Sent video: ${fileName} (${sizeStr})\n\nDownload: [${fileName}](${serveUrl})` }],
            details,
          };
        }

        // Generic file
        return {
          content: [{ type: 'text' as const, text: `Sent file: ${fileName} (${sizeStr})\n\nDownload: [${fileName}](${serveUrl})` }],
          details,
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `Failed to send file: ${err.message ?? String(err)}` }],
          details: null,
        };
      }
    },
  };
}
