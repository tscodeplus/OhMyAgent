// src/tools/shell-command-policy/dangerous-patterns.ts
//
// Dangerous command pattern detection (warn, not hard-blocked).

import type { DangerousPatternEntry, NormalizedShellCommand } from './types.js';

export type { DangerousPatternEntry } from './types.js';

export const DANGEROUS_PATTERNS: DangerousPatternEntry[] = [
  // Remote code execution
  { category: 'remote-exec', pattern: 'curl.*\\|.*\\b(bash|sh|zsh|dash|ksh)\\b', description: 'curl to shell pipe' },
  { category: 'remote-exec', pattern: 'wget.*\\|.*\\b(bash|sh|zsh|dash|ksh)\\b', description: 'wget to shell pipe' },
  { category: 'remote-exec', pattern: '.*\\|\\s*(bash|sh|zsh)\\b', description: 'pipe to shell interpreter' },
  // SQL destruction
  { category: 'sql-destroy', pattern: '\\bDROP\\s+(TABLE|DATABASE|SCHEMA)\\b', description: 'drop database object' },
  { category: 'sql-destroy', pattern: '\\bDELETE\\s+FROM\\b(?!.*\\bWHERE\\b)', description: 'delete without where clause' },
  { category: 'sql-destroy', pattern: '\\bTRUNCATE\\s+(TABLE\\s+)?', description: 'truncate table' },
  // Permission changes
  { category: 'permission', pattern: 'chmod\\s+777', description: 'world-writable permissions' },
  { category: 'permission', pattern: 'chmod\\s+666', description: 'world-writable file' },
  { category: 'permission', pattern: 'chmod\\s+.*o\\+w', description: 'add world write permission' },
  { category: 'permission', pattern: 'chown\\s+-R\\s+(root|0)\\b', description: 'recursive change to root' },
  // Bulk deletion
  { category: 'bulk-delete', pattern: 'find\\s+.*-exec\\s+rm\\b', description: 'find exec rm' },
  { category: 'bulk-delete', pattern: 'find\\s+.*-delete\\b', description: 'find delete' },
  { category: 'bulk-delete', pattern: 'xargs\\s+.*rm\\b', description: 'xargs rm' },
  // Sensitive file overwrite
  { category: 'sensitive-overwrite', pattern: '>\\s*[~$]/\\.ssh/', description: 'overwrite ssh directory' },
  { category: 'sensitive-overwrite', pattern: '>\\s*[~$]/\\.bashrc', description: 'overwrite bashrc' },
  { category: 'sensitive-overwrite', pattern: '>\\s*[~$]/\\.zshrc', description: 'overwrite zshrc' },
  { category: 'sensitive-overwrite', pattern: '>\\s*\\.env', description: 'overwrite .env file' },
  { category: 'sensitive-overwrite', pattern: '>\\s*/etc/', description: 'overwrite system config' },
  // Git destructive
  { category: 'git-destructive', pattern: 'git\\s+push\\s+.*(-f|--force)\\b', description: 'git force push' },
  { category: 'git-destructive', pattern: 'git\\s+reset\\s+--hard\\b', description: 'git hard reset' },
  { category: 'git-destructive', pattern: 'git\\s+clean\\s+.*(-f|--force)', description: 'git clean force' },
  { category: 'git-destructive', pattern: 'git\\s+branch\\s+-D\\b', description: 'git force delete branch' },
  // Kill signals
  { category: 'kill-dangerous', pattern: 'kill\\s+-9\\b', description: 'force kill process' },
  { category: 'kill-dangerous', pattern: 'pkill\\s+-9\\b', description: 'force pkill' },
  { category: 'kill-dangerous', pattern: 'killall\\s+-9\\b', description: 'force killall' },
];

export function detectDangerousPatterns(command: NormalizedShellCommand): DangerousPatternEntry | null {
  const target = command.raw.trim().replace(/\s+/g, ' ');
  for (const entry of DANGEROUS_PATTERNS) {
    try {
      if (new RegExp(entry.pattern, 'i').test(target)) {
        return entry;
      }
    } catch {
      // Skip invalid regex
    }
  }
  return null;
}
