/**
 * Signed download routes — /dl/<token>/<filename>.
 *
 * The token is an HMAC-signed payload (see src/shared/download-token.ts) that
 * encodes the absolute file path and expiry. The filename in the URL is purely
 * cosmetic (for download filename suggestion).
 *
 * Security:
 * - Token MUST be valid and unexpired
 * - Resolved path MUST be within allowed roots
 * - Path traversal is rejected
 * - WebUI bearer auth still applies (see the note in the handler below)
 * - Content a browser could execute is forced to attachment (files-routes.ts)
 */

import type { FastifyInstance } from 'fastify';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, sep, extname, basename } from 'node:path';
import { verifyDownloadToken } from '../../shared/download-token.js';
import { dataPath } from '../../shared/agent-home.js';
import { isWithinRoot } from '../../shared/path-utils.js';
import { applyFileResponseHeaders } from './files-routes.js';

// ---------------------------------------------------------------------------
// Allowed roots
// ---------------------------------------------------------------------------

const DOWNLOADS_DIR = dataPath('downloads');
const TMP_DIR = '/tmp';
const GENERATED_IMAGES_DIR = dataPath('generated-images');
const GENERATED_VIDEOS_DIR = dataPath('generated-videos');
const CHAT_UPLOADS_DIR = dataPath('chat-uploads');
// Attachment store cache dir (used by the multimodal pipeline)
const ATTACHMENT_CACHE_DIR = dataPath('attachments');

function getAllowedRoots(): string[] {
  return [
    DOWNLOADS_DIR,
    TMP_DIR,
    GENERATED_IMAGES_DIR,
    GENERATED_VIDEOS_DIR,
    CHAT_UPLOADS_DIR,
    ATTACHMENT_CACHE_DIR,
  ];
}

// ---------------------------------------------------------------------------
// MIME types
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
};

const MAX_SERVE_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB for images (inline display)

export function registerPublicDownloadRoutes(app: FastifyInstance): void {
  // NOTE: despite the module name this route is NOT exempt from WebUI auth.
  // webuiAuthHook is a plain onRequest hook on the root instance that only
  // matches URL prefixes (see PUBLIC_PREFIXES in src/app/webui-auth.ts) and
  // never reads route config, and /dl is not in that list — so a bearer token
  // is required here. The old `config: { skipAuth: true }` option was inert
  // dead weight and has been removed rather than wired up: making the route
  // genuinely anonymous would trade a working signed-link capability for a
  // wider anonymous read surface, which is a product decision, not a fix.

  app.get('/dl/:token/:filename', async (request, reply) => {
    try {
      const { token, filename } = request.params as { token: string; filename: string };

      // 1. Verify token
      const decoded = verifyDownloadToken(token);
      if (!decoded) {
        return reply.status(403).send({ error: 'Invalid or expired download token' });
      }

      const filePath = decoded.filePath;

      // 2. Path escape check
      if (filePath.includes('..')) {
        return reply.status(403).send({ error: 'Path traversal denied' });
      }

      // 3. Check file is within allowed roots
      const allowedRoots = getAllowedRoots();
      const isAllowed = allowedRoots.some((root) => isWithinRoot(filePath, root));
      if (!isAllowed) {
        return reply.status(403).send({ error: 'File path is outside allowed directories' });
      }

      // 4. Check file exists
      if (!existsSync(filePath)) {
        return reply.status(404).send({ error: 'File not found' });
      }

      // 5. Size check
      const stat = statSync(filePath);
      if (stat.isDirectory()) {
        return reply.status(400).send({ error: 'Cannot download directory' });
      }

      const ext = extname(filePath).toLowerCase();
      const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'].includes(
        ext,
      );
      const maxSize = isImage ? MAX_IMAGE_SIZE : MAX_SERVE_SIZE;

      if (stat.size > maxSize) {
        return reply.status(413).send({
          error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB, max ${maxSize / 1024 / 1024} MB)`,
        });
      }

      // 6. Stream the file
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const stream = createReadStream(filePath);
      const displayName = decodeURIComponent(filename || basename(filePath));

      // Images and videos: serve inline so they render in <img>/<video> tags.
      // The shared helper clamps that request for anything a browser can
      // execute or sniff (SVG included).
      const isInline = isImage || ['.mp4', '.webm', '.mov', '.avi', '.mkv'].includes(ext);

      return applyFileResponseHeaders(reply, {
        contentType,
        filename: displayName,
        ext,
        allowInline: isInline,
      })
        .header('Content-Length', stat.size.toString())
        .header('Cache-Control', 'public, max-age=3600')
        .send(stream);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });
}
