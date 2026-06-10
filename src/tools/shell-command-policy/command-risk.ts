/**
 * Command risk assessment — channel-agnostic heuristic for grading a shell
 * command's risk level (low / medium / high).
 *
 * Previously lived in the Feishu approval-card renderer, but the logic only
 * depends on the shell-command-policy primitives, not on any channel, so it
 * belongs here where every channel (and the agent core) can reuse it.
 */

import { ADB_TEMPLATES } from './adb-templates.js';
import { normalizeCommand } from './parser.js';
import { matchesPattern } from './pattern-matcher.js';

export type CommandRisk = 'low' | 'medium' | 'high';

/** Keywords that indicate high-risk non-ADB commands. */
const HIGH_RISK_KEYWORDS = [
  'install',
  'uninstall',
  'rm',
  'kill',
  'reboot',
  'root',
  'su',
  'chmod 777',
  'dd',
  'mkfs',
];

/** Keywords that indicate medium-risk non-ADB commands. */
const MEDIUM_RISK_KEYWORDS = [
  'connect',
  'disconnect',
  'push',
  'pull',
  'shell input',
  'shell settings',
  'dumpsys',
  'pm',
];

/**
 * Assess the risk level of a shell command.
 *
 * First checks ADB_TEMPLATES for a matching pattern.
 * Falls back to keyword-based detection for non-ADB commands.
 * Defaults to 'low' when nothing matches.
 */
export function assessCommandRisk(command: string): CommandRisk {
  const normalized = normalizeCommand(command);

  // Check ADB templates first
  for (const tpl of ADB_TEMPLATES) {
    if (matchesPattern(tpl.patternType, tpl.pattern, normalized)) {
      return tpl.risk;
    }
  }

  // Non-ADB fallback: keyword matching
  const lower = command.toLowerCase();

  for (const kw of HIGH_RISK_KEYWORDS) {
    if (lower.includes(kw)) {
      return 'high';
    }
  }

  for (const kw of MEDIUM_RISK_KEYWORDS) {
    if (lower.includes(kw)) {
      return 'medium';
    }
  }

  return 'low';
}
