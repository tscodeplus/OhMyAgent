// ---------------------------------------------------------------------------
// v4 ToolDefinition for the enter_worktree tool
// ---------------------------------------------------------------------------

import { Type } from '@sinclair/typebox';
import { execFileSync, execSync } from 'node:child_process';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { textResult, errorResult } from '../../platform/tool-result.js';
import { sessionMetadata } from './shared-metadata.js';

export const enterWorktreeCapability: ToolCapabilityDescriptor = {
  category: 'session',
  readOnly: false,
  readsFiles: true,
  writesFiles: true,
  usesShell: true,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'read_write',
  approvalDefault: 'mutating',
};

const EnterWorktreeParams = Type.Object({
  name: Type.Optional(Type.String()),
});

interface EnterWorktreeArgs {
  name?: string;
}

export function createEnterWorktreeToolDefinition(): ToolDefinition {
  return {
    name: 'enter_worktree',
    label: 'Enter Worktree',
    description: 'Create an isolated git worktree. Name is optional; auto-generated if omitted.',
    category: 'session',
    parametersSchema: EnterWorktreeParams,
    capability: enterWorktreeCapability,
    execute: async (args: EnterWorktreeArgs, ctx) => {
      const sessionId = ctx.sessionId ?? 'default';

      // Check if we're in a git repository
      let repoRoot: string;
      try {
        repoRoot = execSync('git rev-parse --show-toplevel', {
          encoding: 'utf-8',
          timeout: 10000,
          cwd: ctx.cwd,
        }).trim();
      } catch {
        return errorResult('Not in a git repository. Cannot create worktree.');
      }

      const worktreeName = sanitizeWorktreeName(args.name ?? `worktree-${Date.now()}`);
      const worktreesRoot = resolve(repoRoot, '..', 'worktrees');
      const worktreePath = resolve(worktreesRoot, worktreeName);
      if (!isWithinRoot(worktreePath, worktreesRoot)) {
        return errorResult('Invalid worktree name.');
      }

      try {
        execFileSync('git', ['worktree', 'add', worktreePath, 'HEAD'], {
          encoding: 'utf-8',
          timeout: 30000,
          cwd: repoRoot,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`Failed to create worktree: ${message}`);
      }

      // Store worktree info in session metadata
      const existing = sessionMetadata.get(sessionId) ?? {};
      sessionMetadata.set(sessionId, {
        ...existing,
        worktreePath,
        worktreeName,
        worktreeRepoRoot: repoRoot,
      });

      const info = [
        `Worktree created successfully.`,
        ``,
        `Name: ${worktreeName}`,
        `Path: ${worktreePath}`,
        `Repo Root: ${repoRoot}`,
      ].join('\n');

      return textResult(info, { worktreePath, worktreeName });
    },
  };
}

function sanitizeWorktreeName(value: string): string {
  const sanitized = basename(value).replace(/[^a-zA-Z0-9._-]/g, '_');
  return sanitized || `worktree-${Date.now()}`;
}

function isWithinRoot(filePath: string, root: string): boolean {
  const rel = relative(root, filePath);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}
