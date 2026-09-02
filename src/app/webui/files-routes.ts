/**
 * File Browser API Routes
 *
 * Provides filesystem browsing and file operations for the WebUI.
 * Supports Linux, Windows, Mac, WSL, and Termux with platform detection
 * and configurable root directory switching.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  readFile,
  readdir,
  writeFile as fsWriteFile,
  mkdir,
  rm,
  stat,
  rename as fsRename,
} from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, statSync, createReadStream } from 'node:fs';
import { resolve, join, normalize, sep, extname, basename } from 'node:path';
import { platform } from 'node:os';
import crypto from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { AppConfig } from '../types.js';
import { safeEqual } from '../../shared/safe-equal.js';
import { isWithinRoot } from '../../shared/path-utils.js';
import { dataPath, resolveAgentPath } from '../../shared/agent-home.js';
import { toolAllowedRoots } from '../../tools/platform/serve-roots.js';
import * as archiverModule from 'archiver';
const archiver = archiverModule.default;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FileTreeNode {
  name: string;
  type: 'file' | 'directory';
  path: string;
  size?: number;
  modified?: string;
  children?: FileTreeNode[];
}

interface FilesRouteConfig {
  getConfig: () => AppConfig;
  onConfigChanged: () => void;
  configPath: string;
}

interface PlatformInfo {
  platform: string;
  isWSL: boolean;
  isTermux: boolean;
  suggestedRoots: string[];
  defaultRoot: string;
}

// ---------------------------------------------------------------------------
// Platform Detection
// ---------------------------------------------------------------------------

function detectPlatform(): PlatformInfo {
  const osPlatform = platform();
  let isWSL = false;
  let isTermux = false;

  // WSL detection
  try {
    const version = readFileSync('/proc/version', 'utf-8');
    if (/microsoft|wsl/i.test(version)) {
      isWSL = true;
    }
  } catch {
    // Not Linux or /proc/version not readable
  }

  // Termux detection
  if (process.env.PREFIX === '/data/data/com.termux/files/usr') {
    isTermux = true;
  }

  let suggestedRoots: string[] = [];
  let defaultRoot = '';

  if (isTermux) {
    suggestedRoots = [
      '/data/data/com.termux/files/home',
      '/sdcard',
      '/storage/emulated/0',
    ];
    defaultRoot = '/data/data/com.termux/files/home';
  } else if (isWSL) {
    suggestedRoots = [
      '/home',
      '/mnt/c',
      '/mnt/d',
      '/',
    ];
    defaultRoot = process.env.HOME || '/home';
  } else if (osPlatform === 'linux') {
    suggestedRoots = [
      '/home',
      '/',
      '/mnt',
    ];
    defaultRoot = process.env.HOME || '/home';
  } else if (osPlatform === 'darwin') {
    suggestedRoots = [
      '/Users',
      '/',
      '/Applications',
    ];
    defaultRoot = process.env.HOME || '/Users';
  } else if (osPlatform === 'win32') {
    suggestedRoots = [
      'C:\\',
      'D:\\',
    ];
    defaultRoot = process.env.USERPROFILE || 'C:\\';
  } else {
    suggestedRoots = ['/'];
    defaultRoot = process.env.HOME || '/';
  }

  const platformName = isTermux ? 'Termux' : isWSL ? 'WSL' : osPlatform;

  return {
    platform: platformName,
    isWSL,
    isTermux,
    suggestedRoots,
    defaultRoot,
  };
}

// ---------------------------------------------------------------------------
// In-memory file access approval allowlist (paths approved for serve)
//
// Threat this used to miss: `pendingFileAccess` used to be populated by the
// *requesting client's own* path argument on GET /api/files/serve, and
// POST /api/files/approve-serve then accepted any approvalId from that map.
// One caller could therefore perform both "request" and "approve" steps and
// read any file on the host. A decision now has to carry a grant that only the
// in-process approval round-trip ever sees (see registerFileServeApproval).
// ---------------------------------------------------------------------------

const APPROVAL_TTL_MS = 5 * 60 * 1000; // 5 minutes
/** Cap on outstanding requests so a leak cannot become unbounded memory growth. */
const MAX_PENDING_FILE_ACCESS = 200;

interface PendingFileAccess {
  path: string;
  createdAt: number;
  /** One-time capability handed to the human-facing approval prompt. Only a
   *  caller that received it from that channel can record a decision. */
  grant: string;
  /** Identity the request was presented to (audit; mirrors requesterId in the
   *  agent approval store). */
  requesterId?: string;
}

const fileAccessAllowlist = new Map<string, number>(); // path → expiry timestamp
const pendingFileAccess = new Map<string, PendingFileAccess>(); // approvalId → PendingFileAccess

function isPathApproved(absPath: string): boolean {
  const expiry = fileAccessAllowlist.get(absPath);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    fileAccessAllowlist.delete(absPath);
    return false;
  }
  return true;
}

function pruneExpiredFileAccess(): void {
  const now = Date.now();
  for (const [id, entry] of pendingFileAccess) {
    if (now - entry.createdAt > APPROVAL_TTL_MS) pendingFileAccess.delete(id);
  }
}

/**
 * Register a file-access approval request from server-side code (the agent
 * tool pipeline that is about to present a real approval prompt), never from
 * an HTTP request body.
 *
 * Returns the approvalId plus the one-time grant that MUST be presented back to
 * POST /api/files/approve-serve for the decision to count. The grant is random
 * per-process and is not readable through any HTTP endpoint, so a caller that
 * can only make requests cannot approve its own access. Returns null when the
 * pending set is full.
 */
export function registerFileServeApproval(params: {
  path: string;
  requesterId?: string;
}): { approvalId: string; grant: string } | null {
  pruneExpiredFileAccess();
  if (pendingFileAccess.size >= MAX_PENDING_FILE_ACCESS) return null;
  const approvalId = crypto.randomUUID();
  const grant = crypto.randomBytes(24).toString('base64url');
  pendingFileAccess.set(approvalId, {
    path: resolve(params.path),
    createdAt: Date.now(),
    grant,
    requesterId: params.requesterId,
  });
  return { approvalId, grant };
}

/**
 * Outstanding approval requests. Grants are intentionally NOT part of this
 * shape — the list is readable over HTTP by the client that wants the file, and
 * must stay useless to it without the grant it was never given.
 */
export function pendingFileServeApprovals(): { approvalId: string; path: string }[] {
  pruneExpiredFileAccess();
  return [...pendingFileAccess.entries()].map(([approvalId, entry]) => ({
    approvalId,
    path: entry.path,
  }));
}

export function resetFileServeApprovals(): void {
  // Only used for testing.
  pendingFileAccess.clear();
  fileAccessAllowlist.clear();
}

/**
 * Grant serve access for an absolute path directly from an in-process human
 * decision — report #6b option B. The agent approval flow calls this when an
 * operator approves a file-access card for a path outside the served roots,
 * so the WebUI can render that file for the approval TTL. No HTTP caller can
 * reach this function; it exists only for the approval-card round trip.
 */
export function grantFileServeAccess(path: string): void {
  if (fileAccessAllowlist.size >= MAX_PENDING_FILE_ACCESS) pruneExpiredFileAccess();
  fileAccessAllowlist.set(resolve(path), Date.now() + APPROVAL_TTL_MS);
}

// ---------------------------------------------------------------------------
// fileRoot persistence (direct YAML read/write, avoids config-loader coupling)
// ---------------------------------------------------------------------------

const PLATFORM_INFO = detectPlatform();

function readFileRoot(configPath: string): string {
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const yaml = parseYaml(raw) as Record<string, unknown> | null;
    const root = (yaml?.webui as Record<string, unknown>)?.file_root as string | undefined;
    if (root && typeof root === 'string' && root.trim()) {
      return root.trim();
    }
  } catch {
    // Config not readable — fall back to default
  }
  return PLATFORM_INFO.defaultRoot;
}

/** True for Windows drive-letter absolute paths (C:\..., D:/...). */
function isDriveLetterPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p);
}

/**
 * Allowed roots for /api/files/serve and /api/files/download — the union of
 * the shared tool roots (cwd, /tmp, homedir, see toolAllowedRoots) plus
 * webui.file_root and the image/video generation output dirs. Kept aligned
 * with webui_send_media so a path the tool accepts is always servable here;
 * a mismatch surfaces as "sent but can't preview" (403 Path traversal denied).
 */
export function computeServeAllowedRoots(appConfig: AppConfig, fileRoot: string): string[] {
  const roots: string[] = [fileRoot, ...toolAllowedRoots()];
  const imgOut = appConfig.multimodal?.imageGeneration?.outputDir || './data/generated-images';
  const vidOut = appConfig.multimodal?.videoGeneration?.outputDir || './data/generated-videos';
  // computer_use send_screenshot drops captured PNGs here (chat-routes.ts
  // computerUseImageSender) so they can be served to the WebUI chat.
  const cuOut = './data/computer-use-screenshots';
  for (const dir of [imgOut, vidOut, cuOut]) {
    const resolved = resolveAgentPath(dir);
    if (!roots.some(r => resolve(r) === resolved)) {
      roots.unshift(resolved);
    }
  }
  return roots;
}

function writeFileRoot(configPath: string, root: string): void {
  let yaml: Record<string, unknown> = {};
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = parseYaml(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      yaml = parsed as Record<string, unknown>;
    }
  } catch {
    // File doesn't exist or is empty — start fresh
  }

  yaml.webui = { ...((yaml.webui as Record<string, unknown>) ?? {}), file_root: root };

  writeFileSync(configPath, stringifyYaml(yaml), 'utf-8');
}

// ---------------------------------------------------------------------------
// Path Security
// ---------------------------------------------------------------------------

// Containment is checked by the shared isWithinRoot() — one implementation for
// every root guard in the codebase, so file serve cannot drift from the tool
// and policy guards that protect the same paths.

function safeResolve(root: string, userPath: string): string {
  const normalized = normalize(userPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const resolved = resolve(root, normalized);

  // Ensure resolved path stays within root
  if (!isWithinRoot(resolved, root)) {
    throw new Error('Path traversal denied');
  }

  return resolved;
}

/**
 * Confinement check for parameters that name a tree to *walk* rather than a
 * single file to read.
 *
 * safeResolve() clamps a leading "../" away (a convenience for the file editor
 * UX); that is the wrong property for a directory listing, where the traversal
 * attempt itself is the payload. Here anything that resolves outside `root` —
 * parent-directory segments, an absolute path under a different root, or a
 * mix of both — is denied outright.
 */
function strictResolveWithinRoot(root: string, userPath: string): string {
  const resolved = resolve(root, normalize(userPath));
  if (!isWithinRoot(resolved, root)) {
    throw new Error('Path traversal denied');
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Response safety for served files
// ---------------------------------------------------------------------------

/**
 * Extensions whose bodies a browser will render or sniff as script/markup.
 * Serving any of these inline from the gateway origin turns attacker-influenced
 * content into stored XSS — and that origin is where the WebUI bearer token
 * lives, so one script there is a full API takeover. They are always delivered
 * as an attachment, whatever the caller asked for.
 */
const NEVER_INLINE_EXTS = new Set([
  '.html', '.htm', '.xhtml', '.svg', '.svgz', '.xml', '.xsl',
  '.js', '.mjs', '.cjs',
]);

const NEVER_INLINE_MIME_TYPES = new Set([
  'text/html', 'text/xhtml', 'application/xhtml+xml', 'image/svg+xml',
  'application/xml', 'text/xml', 'application/xml-dtd',
  'text/javascript', 'application/javascript', 'application/x-javascript',
  'text/ecmascript', 'application/ecmascript',
]);

/**
 * The only content these routes render inline on purpose: raster images,
 * audio and video, plus plain text/markdown/JSON. Anything else fails closed to
 * an attachment — the mime tables on the routes are not exhaustive, and the
 * browser's fallback for an unrecognised inline body is to sniff it.
 */
const INLINE_ALLOWED_MIME_RE =
  /^(image\/(png|jpeg|gif|webp|bmp|apng|tiff|x-icon)$|video\/|audio\/|text\/plain$|text\/markdown$|application\/json$)/;

/** True when `contentType`/`ext` must never be rendered inline by the browser. */
export function isUnsafeInlineContent(ext: string, contentType: string): boolean {
  if (NEVER_INLINE_EXTS.has(ext.toLowerCase())) return true;
  const type = contentType.toLowerCase().split(';')[0].trim();
  if (NEVER_INLINE_MIME_TYPES.has(type)) return true;
  return !INLINE_ALLOWED_MIME_RE.test(type);
}

/**
 * Apply the download/preview headers shared by every file-serving response.
 *
 * `allowInline` is clamped to false for anything {@link isUnsafeInlineContent}
 * rejects, so a caller cannot opt into inline HTML/SVG by omitting ?download.
 * `X-Content-Type-Options: nosniff` goes on every file response so a body that
 * disagrees with its declared type is never re-typed by the browser.
 */
export function applyFileResponseHeaders(
  reply: FastifyReply,
  params: { contentType: string; filename: string; allowInline: boolean; ext?: string },
): FastifyReply {
  const inline = params.allowInline
    && !isUnsafeInlineContent(params.ext ?? extname(params.filename), params.contentType);
  return reply
    .header('Content-Type', params.contentType)
    .header('X-Content-Type-Options', 'nosniff')
    .header(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(params.filename)}"`,
    );
}

// ---------------------------------------------------------------------------
// File Tree Builder
// ---------------------------------------------------------------------------

const MAX_DEPTH = 3;
const MAX_FILE_SIZE = 1_048_576; // 1 MB (for text file content/editing)
const MAX_SERVE_SIZE = 50 * 1024 * 1024; // 50 MB (for image/video serving)

async function buildFileTree(dirPath: string, depth: number): Promise<FileTreeNode[]> {
  if (depth > MAX_DEPTH) return [];

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  // Sort: directories first, then files, both alphabetically
  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  const nodes: FileTreeNode[] = [];

  for (const entry of entries) {
    // Skip hidden files/dirs (except .env files and similar)
    if (entry.name.startsWith('.') && !entry.name.startsWith('.env')) continue;

    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      const children = await buildFileTree(fullPath, depth + 1);
      nodes.push({
        name: entry.name,
        type: 'directory',
        path: fullPath,
        children: children.length > 0 ? children : undefined,
      });
    } else if (entry.isFile()) {
      try {
        const s = await stat(fullPath);
        nodes.push({
          name: entry.name,
          type: 'file',
          path: fullPath,
          size: s.size,
          modified: s.mtime.toISOString(),
        });
      } catch {
        // File vanished — skip
      }
    }
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// Route Registration
// ---------------------------------------------------------------------------

export function registerFilesRoutes(app: FastifyInstance, cfg: FilesRouteConfig): void {
  // ---- GET /api/files/roots ----
  app.get('/api/files/roots', async (_request, reply) => {
    const currentRoot = readFileRoot(cfg.configPath);
    return reply.send({
      ...PLATFORM_INFO,
      currentRoot,
    });
  });

  // ---- PUT /api/files/root ----
  // This endpoint is the deliberate operator-facing escape hatch: file_root
  // is a configuration preference, not a security boundary (any authenticated
  // user can move it), which is why the routes below enforce containment
  // against the *current* root while this one accepts any existing absolute
  // directory. Bearer auth is the barrier here, by design.
  app.put('/api/files/root', async (request, reply) => {
    const { root } = request.body as { root: string };
    if (!root || typeof root !== 'string') {
      return reply.status(400).send({ error: 'root is required' });
    }

    const resolved = resolve(root);
    if (!existsSync(resolved)) {
      return reply.status(400).send({ error: `Directory not found: ${resolved}` });
    }

    const s = statSync(resolved);
    if (!s.isDirectory()) {
      return reply.status(400).send({ error: `Not a directory: ${resolved}` });
    }

    writeFileRoot(cfg.configPath, resolved);
    cfg.onConfigChanged();

    return reply.send({ ok: true, root: resolved });
  });

  // ---- GET /api/files/tree ----
  app.get('/api/files/tree', async (request, reply) => {
    try {
      const query = request.query as { root?: string };
      // Confinement: the tree walks recursively and returns full paths, so an
      // unconfined root is a whole-filesystem listing. Everything outside
      // webui.file_root must go through PUT /api/files/root first, exactly like
      // the read/write/delete siblings of this route.
      const fileRoot = resolve(readFileRoot(cfg.configPath));
      const root = query.root ? strictResolveWithinRoot(fileRoot, query.root) : fileRoot;

      if (!existsSync(root)) {
        return reply.status(404).send({ error: `Directory not found: ${root}` });
      }
      if (!statSync(root).isDirectory()) {
        return reply.status(400).send({ error: `Not a directory: ${root}` });
      }

      const tree = await buildFileTree(root, 0);
      return reply.send({ root, tree });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message === 'Path traversal denied' ? 403 : 500;
      return reply.status(status).send({ error: message });
    }
  });

  // ---- GET /api/files/content ----
  app.get('/api/files/content', async (request, reply) => {
    try {
      const query = request.query as { path: string; download?: string };
      if (!query.path) {
        return reply.status(400).send({ error: 'path is required' });
      }

      const root = resolve(readFileRoot(cfg.configPath));
      const filePath = safeResolve(root, query.path);

      if (!existsSync(filePath)) {
        return reply.status(404).send({ error: 'File not found' });
      }

      const s = await stat(filePath);
      if (s.isDirectory()) {
        return reply.status(400).send({ error: 'Cannot read directory as file' });
      }
      if (s.size > MAX_FILE_SIZE) {
        return reply.status(413).send({ error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)` });
      }

      const content = await readFile(filePath, 'utf-8');
      const download = query.download;
      if (download !== undefined) {
        // Download mode
        const fileName = filePath.split(sep).pop() || 'download';
        return applyFileResponseHeaders(reply, {
          contentType: 'application/octet-stream',
          filename: fileName,
          allowInline: false,
          ext: extname(filePath),
        }).send(content);
      }

      return reply.send({ path: filePath, content, size: s.size });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message === 'Path traversal denied' ? 403 : 500;
      return reply.status(status).send({ error: message });
    }
  });

  // ---- PUT /api/files/content ----
  app.put('/api/files/content', async (request, reply) => {
    try {
      const { path: filePath, content } = request.body as { path: string; content: string };

      if (!filePath || typeof content !== 'string') {
        return reply.status(400).send({ error: 'path and content are required' });
      }

      const root = resolve(readFileRoot(cfg.configPath));
      const resolvedPath = safeResolve(root, filePath);

      if (!existsSync(resolvedPath)) {
        return reply.status(404).send({ error: 'File not found' });
      }

      const s = await stat(resolvedPath);
      if (s.isDirectory()) {
        return reply.status(400).send({ error: 'Cannot write to directory' });
      }

      await fsWriteFile(resolvedPath, content, 'utf-8');

      return reply.send({ ok: true, path: resolvedPath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message === 'Path traversal denied' ? 403 : 500;
      return reply.status(status).send({ error: message });
    }
  });

  // ---- GET /api/files/download ----
  app.get('/api/files/download', async (request, reply) => {
    try {
      const query = request.query as { path: string };
      if (!query.path) {
        return reply.status(400).send({ error: 'path is required' });
      }

      // Resolve path against multiple allowed roots (shared with webui_send_media)
      const appConfig = cfg.getConfig();
      const fileRoot = resolve(readFileRoot(cfg.configPath));
      const allowedRoots = computeServeAllowedRoots(appConfig, fileRoot);

      let filePath: string | null = null;
      const normalized = normalize(query.path);

      if (normalized.startsWith('/') || normalized.startsWith('\\') || isDriveLetterPath(normalized)) {
        // Absolute path: verify within an allowed root
        const resolvedAbs = resolve(normalized);
        for (const root of allowedRoots) {
          if (isWithinRoot(resolvedAbs, root)) {
            filePath = resolvedAbs;
            break;
          }
        }
      } else {
        // Relative path: try each root
        for (const root of allowedRoots) {
          const candidate = resolve(root, normalized);
          if (existsSync(candidate)) {
            if (isWithinRoot(candidate, root)) {
              filePath = candidate;
              break;
            }
          }
        }
      }

      if (!filePath) {
        return reply.status(403).send({ error: 'Path traversal denied' });
      }

      if (!existsSync(filePath)) {
        return reply.status(404).send({ error: 'File not found' });
      }

      const s = await stat(filePath);
      if (s.isDirectory()) {
        return reply.status(400).send({ error: 'Use /api/files/download-zip for directories' });
      }

      const fileName = filePath.split(sep).pop() || 'download';
      const stream = createReadStream(filePath);

      return applyFileResponseHeaders(reply, {
        contentType: 'application/octet-stream',
        filename: fileName,
        allowInline: false,
        ext: extname(filePath),
      })
        .header('Content-Length', s.size.toString())
        .send(stream);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message === 'Path traversal denied' ? 403 : 500;
      return reply.status(status).send({ error: message });
    }
  });

  // ---- GET /api/files/serve ----
  // Serves files inline with correct MIME type — for <img> tags and media display.
  // Supports both absolute paths and relative paths (relative to file_root).
  // Tries multiple allowed roots so agents can reference files by absolute path.
  // Add ?download=1 to force download with the original filename.
  app.get('/api/files/serve', async (request, reply) => {
    try {
      const query = request.query as { path: string; download?: string };
      if (!query.path) {
        return reply.status(400).send({ error: 'path is required' });
      }
      const asDownload = query.download !== undefined;

      // Allowed roots (in priority order):
      // 1. Configured image/video generation output directories
      // 2. The webui.file_root (Files Browser root)
      // 3. Shared tool roots: /tmp, homedir, cwd (must match webui_send_media)
      const appConfig = cfg.getConfig();
      const fileRoot = resolve(readFileRoot(cfg.configPath));
      const allowedRoots = computeServeAllowedRoots(appConfig, fileRoot);

      // Try to resolve the path against each allowed root
      let filePath: string | null = null;
      const normalized = normalize(query.path);

      if (normalized.startsWith('/') || normalized.startsWith('\\') || isDriveLetterPath(normalized)) {
        // Absolute path: verify it's within an allowed root
        const resolvedAbs = resolve(normalized);
        for (const root of allowedRoots) {
          if (isWithinRoot(resolvedAbs, root)) {
            filePath = resolvedAbs;
            break;
          }
        }
        if (!filePath) {
          // Out of every served root. isPathApproved() is the only way in, and
          // its entries are created exclusively by in-process human decisions:
          // grantFileServeAccess from the agent approval card (option B) or
          // POST /api/files/approve-serve presenting a grant issued in-process
          // (see registerFileServeApproval). The requesting client can neither
          // create a pending request here nor approve one it created itself.
          if (!isPathApproved(resolvedAbs)) {
            return reply.status(403).send({
              error: 'Path traversal denied',
              message:
                'Path is outside the served roots — widen webui.file_root, or approve the file-access card in your chat channel and retry within 5 minutes',
            });
          }
          filePath = resolvedAbs;
        }
      } else {
        // Relative path: try each root
        for (const root of allowedRoots) {
          const candidate = resolve(root, normalized);
          if (existsSync(candidate)) {
            // Security check: must be within this root
            if (isWithinRoot(candidate, root)) {
              filePath = candidate;
              break;
            }
          }
        }
        if (!filePath) {
          // Fall back to file_root for consistent error messages
          filePath = safeResolve(fileRoot, query.path);
        }
      }

      if (!existsSync(filePath!)) {
        return reply.status(404).send({ error: 'File not found' });
      }

      const s = await stat(filePath!);
      if (s.isDirectory()) {
        return reply.status(400).send({ error: 'Cannot serve directory' });
      }
      if (s.size > MAX_SERVE_SIZE) {
        return reply.status(413).send({ error: `File too large (max ${MAX_SERVE_SIZE / 1024 / 1024}MB)` });
      }

      const ext = extname(filePath!).toLowerCase();
      const mimeTypes: Record<string, string> = {
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
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      const originalName = (filePath! as string).split(sep).pop() || 'download';

      const stream = createReadStream(filePath!);
      const resp = applyFileResponseHeaders(reply, {
        contentType,
        filename: originalName,
        ext,
        // ?download=1 never grants inline rendering; it only ever removes it.
        allowInline: !asDownload,
      })
        .header('Content-Length', s.size.toString())
        .header('Cache-Control', 'public, max-age=3600');
      return resp.send(stream);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message === 'Path traversal denied' ? 403 : 500;
      return reply.status(status).send({ error: message });
    }
  });

  // ---- GET /api/files/pending-approvals ----
  // Returns pending file access approval requests (for the frontend to show approval cards).
  app.get('/api/files/pending-approvals', async (_request, reply) => {
    return reply.send({ pending: pendingFileServeApprovals() });
  });

  // ---- POST /api/files/approve-serve ----
  // Record a human decision about a pending file access request.
  //
  // `grant` is the proof that the decision came out of the approval
  // round-trip: it is minted by registerFileServeApproval() in-process and
  // delivered to the approval prompt, and no HTTP endpoint ever echoes it back
  // (GET /api/files/pending-approvals lists ids and paths only). A caller that
  // merely knows an approvalId — e.g. the same client that asked for the file —
  // cannot record a decision with it.
  app.post('/api/files/approve-serve', async (request, reply) => {
    try {
      const body = request.body as {
        approvalId?: string;
        decision?: string;
        grant?: string;
      };
      if (!body.approvalId || !body.decision) {
        return reply.status(400).send({ error: 'approvalId and decision are required' });
      }
      if (body.decision !== 'approve' && body.decision !== 'reject') {
        return reply.status(400).send({ error: "decision must be 'approve' or 'reject'" });
      }

      const entry = pendingFileAccess.get(body.approvalId);
      if (!entry) {
        return reply.status(404).send({ error: 'Approval request not found or expired' });
      }
      if (Date.now() - entry.createdAt > APPROVAL_TTL_MS) {
        pendingFileAccess.delete(body.approvalId);
        return reply.status(404).send({ error: 'Approval request not found or expired' });
      }

      if (!safeEqual(body.grant, entry.grant)) {
        // Untrusted decision — consume the request so it cannot be retried
        // against, and grant nothing.
        pendingFileAccess.delete(body.approvalId);
        app.log.warn(
          { approvalId: body.approvalId, path: entry.path },
          '[files] rejected a file-access decision without a valid grant',
        );
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'A file-access decision must present the grant issued with the approval request',
        });
      }

      pendingFileAccess.delete(body.approvalId);

      if (body.decision === 'approve') {
        fileAccessAllowlist.set(entry.path, Date.now() + APPROVAL_TTL_MS);
        return reply.send({ ok: true, path: entry.path });
      }

      return reply.send({ ok: true, rejected: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  // ---- POST /api/files ----
  app.post('/api/files', async (request, reply) => {
    try {
      const { path: parentPath, type, name } = request.body as {
        path?: string;
        type: 'file' | 'directory';
        name: string;
      };

      if (!name || !type) {
        return reply.status(400).send({ error: 'name and type are required' });
      }

      if (!/^[a-zA-Z0-9_. -]{1,255}$/.test(name)) {
        return reply.status(400).send({ error: 'Invalid name' });
      }

      const root = resolve(readFileRoot(cfg.configPath));
      const parentDir = parentPath ? safeResolve(root, parentPath) : root;
      const fullPath = join(parentDir, name);

      if (existsSync(fullPath)) {
        return reply.status(409).send({ error: `Already exists: ${name}` });
      }

      if (type === 'directory') {
        await mkdir(fullPath, { recursive: true });
      } else {
        await fsWriteFile(fullPath, '', 'utf-8');
      }

      return reply.status(201).send({ ok: true, path: fullPath, type, name });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message === 'Path traversal denied' ? 403 : 500;
      return reply.status(status).send({ error: message });
    }
  });

  // ---- PUT /api/files/rename ----
  app.put('/api/files/rename', async (request, reply) => {
    try {
      const { oldPath, newName } = request.body as {
        oldPath: string;
        newName: string;
      };

      if (!oldPath || !newName) {
        return reply.status(400).send({ error: 'oldPath and newName are required' });
      }

      if (!/^[a-zA-Z0-9_. -]{1,255}$/.test(newName)) {
        return reply.status(400).send({ error: 'Invalid new name' });
      }

      const root = resolve(readFileRoot(cfg.configPath));
      const resolvedOld = safeResolve(root, oldPath);

      if (!existsSync(resolvedOld)) {
        return reply.status(404).send({ error: 'File not found' });
      }

      const parentDir = resolvedOld.substring(0, resolvedOld.lastIndexOf(sep));
      const newPath = join(parentDir, newName);

      if (existsSync(newPath) && newPath !== resolvedOld) {
        return reply.status(409).send({ error: `Already exists: ${newName}` });
      }

      await fsRename(resolvedOld, newPath);

      return reply.send({ ok: true, oldPath: resolvedOld, newPath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message === 'Path traversal denied' ? 403 : 500;
      return reply.status(status).send({ error: message });
    }
  });

  // ---- DELETE /api/files ----
  app.delete('/api/files', async (request, reply) => {
    try {
      const { path: filePath } = request.body as { path: string };

      if (!filePath) {
        return reply.status(400).send({ error: 'path is required' });
      }

      const root = resolve(readFileRoot(cfg.configPath));
      const resolvedPath = safeResolve(root, filePath);

      // Refuse to delete the root itself
      if (resolvedPath === root) {
        return reply.status(400).send({ error: 'Cannot delete root directory' });
      }

      if (!existsSync(resolvedPath)) {
        return reply.status(404).send({ error: 'File not found' });
      }

      await rm(resolvedPath, { recursive: true, force: true });

      return reply.send({ ok: true, path: resolvedPath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message === 'Path traversal denied' ? 403 : 500;
      return reply.status(status).send({ error: message });
    }
  });

  // ---- POST /api/files/upload ----
  app.post('/api/files/upload', async (request, reply) => {
    try {
      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ error: 'No file uploaded' });
      }

      // Read additional form fields
      const targetPath = String(data.fields?.targetPath ?? '');
      const relativePathsRaw = String(data.fields?.relativePaths ?? '[]');
      let relativePaths: string[] = [];
      try {
        relativePaths = JSON.parse(relativePathsRaw) as string[];
      } catch {
        relativePaths = [data.filename];
      }

      // Sanitize filename — use only basename to prevent path traversal
      const sanitizedFilename = basename(data.filename);
      const relativePath = relativePaths[0]
        ? basename(relativePaths[0])
        : sanitizedFilename;

      const root = resolve(readFileRoot(cfg.configPath));
      let destDir: string;

      if (targetPath) {
        // File manager upload — use targetPath within file_root
        destDir = safeResolve(root, targetPath);
      } else {
        // Chat attachment upload — use guaranteed-writable directory
        // (file_root may not be writable, e.g. /home)
        destDir = dataPath('chat-uploads');
      }

      if (!existsSync(destDir)) {
        await mkdir(destDir, { recursive: true });
      }

      const destPath = join(destDir, relativePath);

      // Ensure parent directory exists (no-op if destDir already created above)
      const destParent = destPath.substring(0, destPath.lastIndexOf(sep));
      if (!existsSync(destParent)) {
        await mkdir(destParent, { recursive: true });
      }

      const buf = await data.toBuffer();
      await fsWriteFile(destPath, buf);

      return reply.send({ ok: true, path: destPath, size: buf.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  // ---- GET /api/files/download-zip ----
  app.get('/api/files/download-zip', async (request, reply) => {
    try {
      const query = request.query as { path: string };
      const root = resolve(readFileRoot(cfg.configPath));
      const targetPath = query.path ? safeResolve(root, query.path) : root;

      if (!existsSync(targetPath)) {
        return reply.status(404).send({ error: 'Not found' });
      }

      const s = statSync(targetPath);
      const dirName = targetPath.split(sep).pop() || 'download';

      applyFileResponseHeaders(reply, {
        contentType: 'application/zip',
        filename: `${dirName}.zip`,
        ext: '.zip',
        allowInline: false,
      });

      const archive = archiver('zip', { zlib: { level: 1 } });

      archive.on('error', (err: Error) => {
        reply.raw.destroy(err);
      });

      archive.pipe(reply.raw);

      if (s.isDirectory()) {
        archive.directory(targetPath, dirName);
      } else {
        archive.file(targetPath, { name: dirName });
      }

      await archive.finalize();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Headers might already be sent
      if (!reply.sent) {
        const status = message === 'Path traversal denied' ? 403 : 500;
        return reply.status(status).send({ error: message });
      }
    }
  });
}
