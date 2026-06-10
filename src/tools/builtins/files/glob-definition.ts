// ---------------------------------------------------------------------------
// v4 ToolDefinition for the glob tool
// ---------------------------------------------------------------------------

import { readdir, stat } from 'fs/promises';
import { join, relative, resolve } from 'path';
import { Type } from 'typebox';
import type { Static } from 'typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import type { ToolExecutionContext } from '../../platform/tool-context.js';
import { textResult, errorResult } from '../../platform/tool-result.js';

export const globCapability: ToolCapabilityDescriptor = {
  category: 'file',
  readOnly: true,
  readsFiles: true,
  writesFiles: false,
  usesShell: false,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'read',
  approvalDefault: 'none',
};

const paramsSchema = Type.Object({
  pattern: Type.String({ description: 'Glob pattern to match files(supports **, *, ?, [abc])' }),
  cwd: Type.Optional(Type.String({ description: 'Working directory(defaults to current working directory)' })),
  maxResults: Type.Optional(Type.Number({ description: 'Maximum number of results (default 500)' })),
});

type GlobArgs = Static<typeof paramsSchema>;

export function createGlobToolDefinition(): ToolDefinition<GlobArgs> {
  return {
    name: 'glob',
    label: 'Glob',
    description:
      'Search files by glob pattern. Supports **, *, ?, and character classes.',
    category: 'file',
    parametersSchema: paramsSchema,
    capability: globCapability,
    execute: async (args: GlobArgs, ctx: ToolExecutionContext) => {
      const pattern = args.pattern;
      const cwd = resolve(args.cwd ?? ctx.cwd);
      const maxResults = args.maxResults ?? 500;

      try {
        const dirStat = await stat(cwd);
        if (!dirStat.isDirectory()) {
          return errorResult(`Not a directory: ${cwd}`);
        }

        const regex = globToRegex(pattern);
        const results: string[] = [];
        await searchDir(cwd, cwd, regex, results, maxResults);

        if (results.length === 0) {
          return textResult(`No files matching pattern "${pattern}" in ${cwd}`);
        }

        return textResult(results.join('\n'), { count: results.length });
      } catch (error: any) {
        return errorResult(`Glob error: ${error.message}`);
      }
    },
  };
}

async function searchDir(
  root: string,
  dir: string,
  pattern: RegExp,
  results: string[],
  maxResults: number,
): Promise<void> {
  if (results.length >= maxResults) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // Permission error or unreadable — skip silently
  }

  for (const entry of entries) {
    if (results.length >= maxResults) return;

    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      await searchDir(root, join(dir, entry.name), pattern, results, maxResults);
    } else if (entry.isFile()) {
      const relPath = relative(root, join(dir, entry.name));
      if (pattern.test(relPath)) {
        results.push(relPath);
      }
    }
  }
}

/** Convert a glob pattern to a RegExp. Supports **, *, ?, [abc]. */
function globToRegex(pattern: string): RegExp {
  // Escape regex special chars, but leave glob specials (* ? [ ] -) unescaped
  const escaped = pattern
    .replace(/[.+^${}()|\\]/g, '\\$&')
    // **/ and /** are cross-directory matches; handling order matters:
    // (a) **/  → match zero or more leading path segments
    // (b) /**  → match zero or more trailing path segments
    // (c) **   → isolated globstar (e.g. **.ts) → match anything within a single segment
    .replace(/\*\*\//g, '{{GLOBSTAR_SLASH}}')
    .replace(/\/\*\*/g, '{{SLASH_GLOBSTAR}}')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{GLOBSTAR_SLASH\}\}/g, '(.*/)?')
    .replace(/\{\{SLASH_GLOBSTAR\}\}/g, '(/.*)?')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');

  return new RegExp(`^${escaped}$`);
}
