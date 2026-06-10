// src/tools/shell-command-policy/hardline-patterns.ts
//
// Hardline command blocklist — always blocked, no exceptions.

import { matchesPattern } from './pattern-matcher.js';
import type { HardlinePatternEntry, HardlineCheckResult, NormalizedShellCommand } from './types.js';

export type { HardlinePatternEntry, HardlineCheckResult } from './types.js';

export const HARDLINE_PATTERNS: HardlinePatternEntry[] = [
  // Filesystem destruction
  { pattern: '^rm\\s+-rf\\s+/($|\\s|\\*)', type: 'regex', description: 'Recursively delete root filesystem' },
  { pattern: '^rm\\s+-rf\\s+~($|\\s|/)', type: 'regex', description: 'Delete user home directory' },
  { pattern: '^rm\\s+-rf\\s+\\$HOME($|\\s|/)', type: 'regex', description: 'Delete user home directory' },
  { pattern: '^rm\\s+-rf\\s+/home($|\\s|/)', type: 'regex', description: 'Recursively delete /home' },
  { pattern: '^rm\\s+-rf\\s+/etc($|\\s|/)', type: 'regex', description: 'Recursively delete /etc' },
  { pattern: '^rm\\s+-rf\\s+/usr($|\\s|/)', type: 'regex', description: 'Recursively delete /usr' },
  { pattern: '^rm\\s+-rf\\s+/var($|\\s|/)', type: 'regex', description: 'Recursively delete /var' },
  { pattern: '^rm\\s+-rf\\s+/bin($|\\s|/)', type: 'regex', description: 'Recursively delete /bin' },
  { pattern: '^rm\\s+-rf\\s+/root($|\\s|/)', type: 'regex', description: 'Recursively delete /root' },
  // Disk destruction
  { pattern: '^mkfs', type: 'regex', description: 'Format filesystem' },
  { pattern: 'dd\\s+.*of=/dev/sd', type: 'regex', description: 'Write to raw block device' },
  { pattern: '>\\s*/dev/sd', type: 'regex', description: 'Redirect overwrite block device' },
  // System control
  { pattern: 'shutdown', type: 'program', description: 'System shutdown' },
  { pattern: 'reboot', type: 'program', description: 'System reboot' },
  { pattern: 'halt', type: 'program', description: 'System halt' },
  { pattern: 'poweroff', type: 'program', description: 'System power off' },
  { pattern: 'init 0', type: 'exact', description: 'Runlevel 0 — shutdown' },
  { pattern: 'init 6', type: 'exact', description: 'Runlevel 6 — reboot' },
  { pattern: 'systemctl poweroff', type: 'prefix', description: 'systemctl poweroff' },
  { pattern: 'systemctl reboot', type: 'prefix', description: 'systemctl reboot' },
  // Fork bomb
  { pattern: ':(){ :|:& };:', type: 'exact', description: 'Fork bomb' },
  { pattern: 'kill -9 -1', type: 'exact', description: 'Kill all processes' },
];

export function checkHardlineBlocklist(command: NormalizedShellCommand): HardlineCheckResult {
  for (const entry of HARDLINE_PATTERNS) {
    if (matchesPattern(entry.type, entry.pattern, command)) {
      return { blocked: true, pattern: entry.pattern, description: entry.description };
    }
  }
  return { blocked: false };
}
