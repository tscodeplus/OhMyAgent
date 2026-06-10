// ---------------------------------------------------------------------------
// v4 ToolDefinition for the exit_worktree tool
// ---------------------------------------------------------------------------

import { Type } from '@sinclair/typebox';
import { execFileSync } from 'node:child_process';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { textResult, errorResult } from '../../platform/tool-result.js';
import { sessionMetadata } from './shared-metadata.js';

export const exitWorktreeCapability: ToolCapabilityDescriptor = {
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

export function createExitWorktreeToolDefinition(): ToolDefinition {
  return {
    name: 'exit_worktree',
    label: 'Exit Worktree',
    description: 'Remove a git worktree created by enter_worktree.',
    category: 'session',
    parametersSchema: Type.Object({}),
    capability: exitWorktreeCapability,
    execute: async (_args: Record<string, never>, ctx) => {
      const sessionId = ctx.sessionId ?? 'default';
      const metadata = sessionMetadata.get(sessionId);

      if (!metadata?.worktreePath) {
        return errorResult('No worktree found for this session. Use enter_worktree first.');
      }

      const worktreePath = metadata.worktreePath as string;
      const repoRoot = (metadata.worktreeRepoRoot as string) ?? process.cwd();

      try {
        execFileSync('git', ['worktree', 'remove', worktreePath, '--force'], {
          encoding: 'utf-8',
          timeout: 30000,
          cwd: repoRoot,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`Failed to remove worktree: ${message}`);
      }

      // Clear worktree info from metadata
      const { worktreePath: _wp, worktreeName: _wn, worktreeRepoRoot: _rr, ...rest } = metadata as Record<string, unknown>;
      sessionMetadata.set(sessionId, rest);

      return textResult(`Worktree '${worktreePath}' removed successfully.`);
    },
  };
}
