import { readdir, stat } from 'fs/promises';
import { join, relative, resolve } from 'path';
import { Type } from 'typebox';
import { i18n } from '../../i18n/index.js';
import { isWithinRoot } from '../../shared/path-utils.js';
import type { AgentTool } from '../../pi-mono/agent/types.js';
import { matchGlob, type FileReadToolOptions } from './file-read-tool.js';

const MAX_RESULTS = 100;

/** @deprecated Use `createFileSearchToolDefinition` from `./files/search-definition.js` instead. */
export function createFileSearchTool(options?: FileReadToolOptions) {
  const allowedRoots = [process.cwd()];
  if (options?.allowedRoots && options.allowedRoots.length > 0) {
    for (const r of options.allowedRoots) {
      const resolvedPath = resolve(r);
      if (!allowedRoots.includes(resolvedPath)) {
        allowedRoots.push(resolvedPath);
      }
    }
  }
  const deniedPatterns = options?.deniedPatterns ?? [];

  return {
    name: 'file_search',
    label: 'File Search',
    description: 'Search files by name or glob. Use when you do not know exact paths. Restricted dirs trigger approval.',
    parameters: Type.Object({
      directory: Type.String({ description: 'The root directory to search in' }),
      pattern: Type.String({ description: 'Glob-like pattern to match files(e.g., "*.ts", "**/*.json")' }),
      maxResults: Type.Optional(Type.Number({ description: 'Maximum number of results', default: 100 })),
    }),
    execute: async (_toolCallId: string, params: { directory: string; pattern: string; maxResults?: number }) => {
      const maxResults = params.maxResults ?? MAX_RESULTS;
      const pattern = globToRegex(params.pattern);

      try {
        const resolvedDir = resolve(params.directory);

        // Check deny patterns
        for (const denyPattern of deniedPatterns) {
          if (matchGlob(resolvedDir, denyPattern)) {
            return { content: [{ type: 'text', text: i18n.t('tools-builtins:fileRead.accessDenied') }] };
          }
        }

        // Check allowed roots (cross-platform: handles mixed separators + case-insensitive on Windows)
        const allowed = allowedRoots.some(root =>
          isWithinRoot(resolvedDir, resolve(root)),
        );
        if (!allowed) {
          return { content: [{ type: 'text', text: i18n.t('tools-builtins:fileRead.accessDenied') }] };
        }

        const results: string[] = [];
        await searchDir(resolvedDir, resolvedDir, pattern, results, maxResults, deniedPatterns);

        if (results.length === 0) {
          return { content: [{ type: 'text', text: i18n.t('tools-builtins:fileSearch.noResults', { pattern: params.pattern, path: params.directory }) }] };
        }

        return {
          content: [{ type: 'text', text: i18n.t('tools-builtins:fileSearch.results', { count: results.length, list: results.join('\n') }) }],
        };
      } catch (error: any) {
        return { content: [{ type: 'text', text: i18n.t('tools-builtins:fileSearch.error', { message: error.message }) }] };
      }
    },
  } as AgentTool<any>;
}

async function searchDir(
  root: string,
  dir: string,
  pattern: RegExp,
  results: string[],
  maxResults: number,
  deniedPatterns: string[],
): Promise<void> {
  if (results.length >= maxResults) return;

  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (results.length >= maxResults) return;

    // Skip hidden directories and node_modules
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      await searchDir(root, fullPath, pattern, results, maxResults, deniedPatterns);
    } else if (entry.isFile()) {
      const relPath = relative(root, fullPath);
      const denied = deniedPatterns.some(denyPattern =>
        matchGlob(fullPath, denyPattern) ||
        matchGlob(relPath, denyPattern) ||
        matchGlob(entry.name, denyPattern),
      );
      if (denied) continue;
      if (pattern.test(relPath) || pattern.test(entry.name)) {
        results.push(relPath);
      }
    }
  }
}

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports: *, **, ?
 */
function globToRegex(pattern: string): RegExp {
  let regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');

  return new RegExp(`^${regexStr}$`);
}
