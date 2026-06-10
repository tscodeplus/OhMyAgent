// ---------------------------------------------------------------------------
// v4 ToolDefinition for the grep tool
// ---------------------------------------------------------------------------

import { Type } from 'typebox';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { textResult, errorResult } from '../../platform/tool-result.js';

export const grepCapability: ToolCapabilityDescriptor = {
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple glob match against a file's basename. */
function matchGlob(filePath: string, pattern: string): boolean {
  if (pattern === '*' || pattern === '') return true;
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(path.basename(filePath));
}

/** Quick check for null bytes in the first 8 KB — heuristic for binary files. */
function isBinary(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buffer, 0, 8192, 0);
    fs.closeSync(fd);
    return buffer.subarray(0, bytesRead).includes(0);
  } catch {
    return true;
  }
}

/** Recursively walk a directory, yielding file paths. */
function* walkDir(dir: string): Generator<string> {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        yield* walkDir(fullPath);
      } else if (entry.isFile()) {
        yield fullPath;
      }
    }
  } catch {
    // skip directories that cannot be read
  }
}

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export function createGrepToolDefinition(): ToolDefinition {
  return {
    name: 'grep',
    label: 'Grep',
    description:
      'Search files with regex. Supports include globs and result caps.',
    category: 'file',
    parametersSchema: Type.Object({
      pattern: Type.String({
        description: 'The regex pattern to search for',
      }),
      path: Type.Optional(
        Type.String({
          description:
            'The directory to search in (defaults to current working directory)',
        }),
      ),
      include: Type.Optional(
        Type.String({
          description:
            'Glob pattern to filter files (e.g. *.ts). Defaults to * (all files)',
        }),
      ),
      maxResults: Type.Optional(
        Type.Number({
          description: 'Maximum number of results (default 100)',
        }),
      ),
    }),
    capability: grepCapability,
    execute: async (
      args: {
        pattern: string;
        path?: string;
        include?: string;
        maxResults?: number;
      },
      ctx,
    ) => {
      try {
        // Validate and compile regex
        let regex: RegExp;
        try {
          regex = new RegExp(args.pattern);
        } catch (err: any) {
          return errorResult(
            `Invalid regex pattern: "${args.pattern}". ${err.message ?? String(err)}`,
          );
        }

        const searchPath = args.path
          ? path.resolve(ctx.cwd, args.path)
          : process.cwd();
        const includePattern = args.include ?? '*';
        const maxResults = args.maxResults ?? 100;

        const results: string[] = [];

        for (const filePath of walkDir(searchPath)) {
          if (!matchGlob(filePath, includePattern)) continue;
          if (isBinary(filePath)) continue;

          try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                results.push(`${filePath}:${i + 1}: ${lines[i]}`);
                if (results.length >= maxResults) {
                  return textResult(results.join('\n'));
                }
              }
            }
          } catch {
            // skip unreadable files
          }
        }

        if (results.length === 0) {
          return textResult(
            `No matches found for pattern "${args.pattern}" in ${searchPath}`,
          );
        }

        return textResult(results.join('\n'));
      } catch (err: any) {
        return errorResult(
          `Failed to search: ${err.message ?? String(err)}`,
        );
      }
    },
  };
}
