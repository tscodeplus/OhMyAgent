import { readdir, stat } from 'fs/promises';
import { basename, join, relative, resolve } from 'path';
import { Type } from 'typebox';
import { i18n } from '../../i18n/index.js';
import { isWithinRoot, allowedRootsWithFallback } from '../../shared/path-utils.js';
import { globToRegExp, isDeniedByPattern, matchGlobGreedy } from '../../shared/glob.js';
import type { AgentTool } from '../../pi-mono/agent/types.js';
import type { FileReadToolOptions } from './file-read-tool.js';

const MAX_RESULTS = 100;

/** @deprecated Use `createFileSearchToolDefinition` from `./files/search-definition.js` instead. */
export function createFileSearchTool(options?: FileReadToolOptions) {
  const allowedRoots = allowedRootsWithFallback(options?.allowedRoots);
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
      const pattern = globToRegExp(params.pattern);

      try {
        const resolvedDir = resolve(params.directory);

        // Check deny patterns
        for (const denyPattern of deniedPatterns) {
          if (matchGlobGreedy(resolvedDir, denyPattern)) {
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
        isDeniedByPattern(fullPath, entry.name, denyPattern) ||
        matchGlobGreedy(relPath, denyPattern),
      );
      if (denied) continue;
      if (pattern.test(relPath) || pattern.test(entry.name)) {
        results.push(relPath);
      }
    }
  }
}
