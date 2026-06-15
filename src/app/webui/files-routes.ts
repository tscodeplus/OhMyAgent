/**
 * File Browser API Routes
 *
 * Provides filesystem browsing and file operations for the WebUI.
 * Supports Linux, Windows, Mac, WSL, and Termux with platform detection
 * and configurable root directory switching.
 */

import type { FastifyInstance } from 'fastify';
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
import { resolve, join, normalize, sep, relative, extname, basename } from 'node:path';
import { platform } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { AppConfig } from '../types.js';
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
// ---------------------------------------------------------------------------

const APPROVAL_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface PendingFileAccess {
  path: string;
  createdAt: number;
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

function safeResolve(root: string, userPath: string): string {
  const normalized = normalize(userPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const resolved = resolve(root, normalized);
  const resolvedRoot = resolve(root);

  // Ensure resolved path stays within root
  if (!resolved.startsWith(resolvedRoot + sep) && resolved !== resolvedRoot) {
    throw new Error('Path traversal denied');
  }

  return resolved;
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
      const root = query.root ? resolve(query.root) : resolve(readFileRoot(cfg.configPath));

      if (!existsSync(root)) {
        const s = statSync(root);
        if (!s.isDirectory()) {
          return reply.status(400).send({ error: `Not a directory: ${root}` });
        }
      }

      const tree = await buildFileTree(root, 0);
      return reply.send({ root, tree });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
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
        return reply
          .header('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`)
          .header('Content-Type', 'application/octet-stream')
          .send(content);
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

      // Resolve path against multiple allowed roots, matching /api/files/serve behavior
      const appConfig = cfg.getConfig();
      const fileRoot = resolve(readFileRoot(cfg.configPath));
      const allowedRoots: string[] = [fileRoot, '/tmp'];
      // Add image/video generation output dirs
      const imgOut = appConfig.multimodal?.imageGeneration?.outputDir || './data/generated-images';
      const vidOut = appConfig.multimodal?.videoGeneration?.outputDir || './data/generated-videos';
      for (const dir of [imgOut, vidOut]) {
        const resolved = resolve(dir);
        if (!allowedRoots.some(r => resolve(r) === resolved)) {
          allowedRoots.unshift(resolved);
        }
      }

      let filePath: string | null = null;
      const normalized = normalize(query.path);

      if (normalized.startsWith('/') || normalized.startsWith('\\')) {
        // Absolute path: verify within an allowed root
        const resolvedAbs = resolve(normalized);
        for (const root of allowedRoots) {
          const resolvedRoot = resolve(root);
          if (resolvedAbs.startsWith(resolvedRoot + sep) || resolvedAbs === resolvedRoot) {
            filePath = resolvedAbs;
            break;
          }
        }
      } else {
        // Relative path: try each root
        for (const root of allowedRoots) {
          const candidate = resolve(root, normalized);
          if (existsSync(candidate)) {
            const resolvedRoot = resolve(root);
            if (candidate.startsWith(resolvedRoot + sep) || candidate === resolvedRoot) {
              filePath = candidate;
              break;
            }
          }
        }
      }

      if (!filePath || !existsSync(filePath)) {
        return reply.status(404).send({ error: 'File not found' });
      }

      const s = await stat(filePath);
      if (s.isDirectory()) {
        return reply.status(400).send({ error: 'Use /api/files/download-zip for directories' });
      }

      const fileName = filePath.split(sep).pop() || 'download';
      const stream = createReadStream(filePath);

      return reply
        .header('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`)
        .header('Content-Type', 'application/octet-stream')
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
      // 3. /tmp (temporary files from shell tools)
      const appConfig = cfg.getConfig();
      const fileRoot = resolve(readFileRoot(cfg.configPath));
      const allowedRoots: string[] = [fileRoot, '/tmp'];
      // Add image/video generation output dirs from config (with defaults)
      const imgOut = appConfig.multimodal?.imageGeneration?.outputDir || './data/generated-images';
      const vidOut = appConfig.multimodal?.videoGeneration?.outputDir || './data/generated-videos';
      for (const dir of [imgOut, vidOut]) {
        const resolved = resolve(dir);
        if (!allowedRoots.some(r => resolve(r) === resolved)) {
          allowedRoots.unshift(resolved);
        }
      }

      // Try to resolve the path against each allowed root
      let filePath: string | null = null;
      const normalized = normalize(query.path);

      if (normalized.startsWith('/') || normalized.startsWith('\\')) {
        // Absolute path: verify it's within an allowed root
        const resolvedAbs = resolve(normalized);
        for (const root of allowedRoots) {
          const resolvedRoot = resolve(root);
          if (resolvedAbs.startsWith(resolvedRoot + sep) || resolvedAbs === resolvedRoot) {
            filePath = resolvedAbs;
            break;
          }
        }
        if (!filePath) {
          // Try to resolve as absolute path and check if already approved
          const resolvedAbs = resolve(normalized);
          if (isPathApproved(resolvedAbs)) {
            filePath = resolvedAbs;
          }
        }
        if (!filePath) {
          // Create a pending approval for this path
          const approvalId = `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const resolvedAbs = resolve(normalized);
          pendingFileAccess.set(approvalId, { path: resolvedAbs, createdAt: Date.now() });
          return reply.status(403).send({
            error: 'Path requires approval',
            needsApproval: true,
            approvalId,
            path: normalized,
          });
        }
      } else {
        // Relative path: try each root
        for (const root of allowedRoots) {
          const candidate = resolve(root, normalized);
          if (existsSync(candidate)) {
            // Security check: must be within this root
            const resolvedRoot = resolve(root);
            if (candidate.startsWith(resolvedRoot + sep) || candidate === resolvedRoot) {
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
      const resp = reply
        .header('Content-Type', contentType)
        .header('Content-Length', s.size.toString())
        .header('Cache-Control', 'public, max-age=3600');
      if (asDownload) {
        resp.header('Content-Disposition', `attachment; filename="${encodeURIComponent(originalName)}"`);
      }
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
    const pending: { approvalId: string; path: string }[] = [];
    const now = Date.now();
    for (const [id, entry] of pendingFileAccess) {
      if (now - entry.createdAt > APPROVAL_TTL_MS) {
        pendingFileAccess.delete(id);
      } else {
        pending.push({ approvalId: id, path: entry.path });
      }
    }
    return reply.send({ pending });
  });

  // ---- POST /api/files/approve-serve ----
  // Approve or reject a pending file access request.
  app.post('/api/files/approve-serve', async (request, reply) => {
    try {
      const body = request.body as { approvalId: string; decision: 'approve' | 'reject' };
      if (!body.approvalId || !body.decision) {
        return reply.status(400).send({ error: 'approvalId and decision are required' });
      }

      const entry = pendingFileAccess.get(body.approvalId);
      if (!entry) {
        return reply.status(404).send({ error: 'Approval request not found or expired' });
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
        destDir = resolve(process.cwd(), 'data', 'chat-uploads');
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

      reply.header('Content-Type', 'application/zip');
      reply.header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(dirName)}.zip"`,
      );

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
