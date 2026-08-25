import { open } from 'fs/promises';
import path from 'path';
import os from 'os';
import { Type } from 'typebox';
import { i18n } from '../../i18n/index.js';
import { isWithinRoot } from '../../shared/path-utils.js';
import type { AgentTool } from '../../pi-mono/agent/types.js';
import type { PolicyCenter } from '../../policy/types.js';
import type { AppConfig } from '../../app/types.js';

const MAX_FILE_SIZE = 100_000; // 100K characters

export function matchGlob(filePath: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(filePath);
}

export interface FileReadToolOptions {
  /** Absolute directory paths that are allowed for reading. Empty falls back to [process.cwd()]. */
  allowedRoots?: string[];
  /** Glob patterns to deny. Supports * wildcard. */
  deniedPatterns?: string[];
}

/**
 * v4: extended deps with optional PolicyCenter for path access evaluation.
 */
export interface FileReadToolDeps {
  /** Application configuration (used for fileRead settings). */
  config: AppConfig;
  /** v4 PolicyCenter for path access evaluation. When provided, replaces the inline path check. */
  policyCenter?: PolicyCenter;
}

/** @deprecated Use `createFileReadToolDefinition` from `./files/read-definition.js` instead.
 * Create a file reading AgentTool.
 *
 * Security model: resolve to absolute path, check deny patterns, check allowed roots.
 * path.resolve() naturally handles `..` traversal — no separate flag needed.
 * `~` is always expanded for convenience; allowed roots check blocks escape attempts.
 *
 * Two calling conventions are supported for backward compatibility:
 * 1. v4: `createFileReadTool({ config, policyCenter? })` — new style with PolicyCenter
 * 2. Legacy: `createFileReadTool({ allowedRoots?, deniedPatterns? })` — old inline path check
 */
export function createFileReadTool(deps: FileReadToolDeps): AgentTool<any>;
export function createFileReadTool(options?: FileReadToolOptions): AgentTool<any>;
export function createFileReadTool(param?: FileReadToolDeps | FileReadToolOptions): AgentTool<any> {
  // Detect which calling convention was used
  const isNewStyle = param !== undefined && 'config' in param;

  // Pre-compute allowed roots and denied patterns from whichever form was passed
  const policyCenter: PolicyCenter | undefined = isNewStyle
    ? (param as FileReadToolDeps).policyCenter
    : undefined;

  const allowedRoots: string[] = [process.cwd()];
  const deniedPatterns: string[] = [];

  if (isNewStyle) {
    const deps = param as FileReadToolDeps;
    if (deps.config.tools.fileRead.allowedRoots.length > 0) {
      for (const r of deps.config.tools.fileRead.allowedRoots) {
        const resolved = path.resolve(r);
        if (!allowedRoots.includes(resolved)) {
          allowedRoots.push(resolved);
        }
      }
    }
    deniedPatterns.push(...deps.config.tools.fileRead.deniedPatterns);
  } else {
    const options = (param || {}) as FileReadToolOptions;
    if (options.allowedRoots && options.allowedRoots.length > 0) {
      for (const r of options.allowedRoots) {
        const resolved = path.resolve(r);
        if (!allowedRoots.includes(resolved)) {
          allowedRoots.push(resolved);
        }
      }
    }
    if (options.deniedPatterns) {
      deniedPatterns.push(...options.deniedPatterns);
    }
  }

  return {
    name: 'file_read',
    label: 'File Read',
    description: 'Read file contents. Use for ANY file — do not pre-check paths. The approval system handles restricted paths.',
    parameters: Type.Object({
      path: Type.String({ description: 'The file path to read' }),
    }),
    execute: async (_toolCallId: string, params: { path: string }, ctx?: any) => {
      try {
        const rawPath = params.path;

        // Resolve to absolute path (always expand ~)
        let resolvedPath: string;
        if (rawPath.startsWith('~')) {
          resolvedPath = path.resolve(os.homedir(), rawPath.slice(rawPath.startsWith('~/') ? 2 : 1));
        } else {
          resolvedPath = path.resolve(rawPath);
        }

        // ---- Path access check (dual approach) ----

        if (policyCenter) {
          // v4: use PolicyCenter for path access evaluation
          const decision = policyCenter.evaluatePathAccess({
            path: resolvedPath,
            operation: 'read',
            sessionId: ctx?.sessionId,
            scope: {
              toolsProfile: 'standard',
              readRoots: allowedRoots,
              writeRoots: [],
              deniedPatterns,
              shellExecMode: 'balanced',
              sessionApprovals: [],
              appApprovals: [],
              readOnly: false,
              computerUseEnabled: false,
              policyMode: 'balanced',
            },
          });
          if (!decision.allowed) {
            return { content: [{ type: 'text' as const, text: i18n.t('tools-builtins:fileRead.accessDenied') }], isError: true };
          }
        } else {
          // ── Legacy path (policyCenter not available) ──
          // Old logic — keep EXACTLY as-is for backward compat
          for (const pattern of deniedPatterns) {
            if (matchGlob(resolvedPath, pattern) || matchGlob(path.basename(resolvedPath), pattern)) {
              return { content: [{ type: 'text' as const, text: i18n.t('tools-builtins:fileRead.accessDenied') }] };
            }
          }

          // Check that resolved path is within an allowed root
          // Use path.relative() which handles mixed separators and is case-insensitive on Windows
          const allowed = allowedRoots.some(root =>
            isWithinRoot(resolvedPath, path.resolve(root)),
          );
          if (!allowed) {
            return { content: [{ type: 'text' as const, text: i18n.t('tools-builtins:fileRead.accessDenied') }] };
          }
        }

        // ---- Read the file ----
        //
        // Size pre-check: stat the opened fd (symlink-safe — the path cannot
        // be swapped between check and read) and reject oversized files before
        // reading, so a multi-GB file is never pulled into memory. The fd read
        // is bounded to the stat'd size, capping memory even if the file grows
        // between stat and read.

        let handle: Awaited<ReturnType<typeof open>> | undefined;
        try {
          handle = await open(resolvedPath, 'r');
          const stats = await handle.stat();
          if (stats.size > MAX_FILE_SIZE) {
            return {
              content: [{ type: 'text' as const, text: i18n.t('tools-builtins:fileRead.tooLarge', { size: stats.size, limit: MAX_FILE_SIZE }) }],
              isError: true,
            };
          }
          // Read at most MAX_FILE_SIZE bytes: UTF-8 bytes >= chars, so a file
          // within the byte limit is also within the character display limit.
          const buffer = Buffer.alloc(Math.max(stats.size, 1));
          let total = 0;
          while (total < buffer.length) {
            const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
            if (bytesRead === 0) break;
            total += bytesRead;
          }
          const content = buffer.subarray(0, total).toString('utf-8');
          return { content: [{ type: 'text' as const, text: content }] };
        } finally {
          await handle?.close();
        }
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          return { content: [{ type: 'text' as const, text: i18n.t('tools-builtins:fileRead.notFound') }], isError: true };
        }
        return { content: [{ type: 'text' as const, text: i18n.t('tools-builtins:fileRead.error') }], isError: true };
      }
    },
  } as AgentTool<any>;
}
