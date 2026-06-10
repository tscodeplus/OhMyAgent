// ---------------------------------------------------------------------------
// v4 ToolDefinition wrapper for the file_search tool
// ---------------------------------------------------------------------------

import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createFileSearchTool } from '../file-search-tool.js';
import type { FileReadToolOptions } from '../file-read-tool.js';
import { textResult, errorResult } from '../../platform/tool-result.js';

export const fileSearchToolCapability: ToolCapabilityDescriptor = {
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

export function createFileSearchToolDefinition(options?: FileReadToolOptions): ToolDefinition {
  const legacyTool = createFileSearchTool(options);

  return {
    name: legacyTool.name,
    label: legacyTool.label,
    description: legacyTool.description,
    category: 'file',
    parametersSchema: legacyTool.parameters,
    capability: fileSearchToolCapability,
    execute: async (args, ctx) => {
      if (ctx.approvalAlreadyHandled) {
        return executeApprovedSearch(args as { directory: string; pattern: string; maxResults?: number });
      }
      const result = await legacyTool.execute('' as any, args as any);
      return {
        content: (result.content ?? []) as any,
        isError: !result.content?.length,
        metadata: result.details as Record<string, unknown> | undefined,
      };
    },
  };
}

async function executeApprovedSearch(args: {
  directory: string;
  pattern: string;
  maxResults?: number;
}) {
  try {
    const maxResults = args.maxResults ?? 100;
    const resolvedDir = resolve(args.directory);
    const pattern = globToRegex(args.pattern);
    const results: string[] = [];
    await searchDir(resolvedDir, resolvedDir, pattern, results, maxResults);

    if (results.length === 0) {
      return textResult(`No files matching pattern "${args.pattern}" in ${args.directory}`);
    }
    return textResult(results.join('\n'), { count: results.length });
  } catch (err: any) {
    return errorResult(`File search error: ${err.message ?? String(err)}`);
  }
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
    return;
  }

  for (const entry of entries) {
    if (results.length >= maxResults) return;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await searchDir(root, fullPath, pattern, results, maxResults);
    } else if (entry.isFile()) {
      const relPath = relative(root, fullPath);
      if (pattern.test(relPath) || pattern.test(entry.name)) {
        results.push(relPath);
      }
    }
  }
}

function globToRegex(pattern: string): RegExp {
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');

  return new RegExp(`^${regexStr}$`);
}
