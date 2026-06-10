// src/tools/shell-command-policy/pattern-matcher.ts
//
// Pattern matching against normalized shell commands.

import type { PatternType, NormalizedShellCommand } from './types.js';

export function matchesExact(pattern: string, command: NormalizedShellCommand): boolean {
  return command.raw.trim().replace(/\s+/g, ' ') === pattern;
}

export function matchesPrefix(pattern: string, command: NormalizedShellCommand): boolean {
  return command.raw.trim().replace(/\s+/g, ' ').startsWith(pattern);
}

export function matchesProgram(pattern: string, command: NormalizedShellCommand): boolean {
  return command.program === pattern;
}

export function matchesRegex(pattern: string, command: NormalizedShellCommand): boolean {
  try {
    const regex = new RegExp(pattern);
    return regex.test(command.raw.trim().replace(/\s+/g, ' '));
  } catch {
    return false;
  }
}

export function matchesPattern(
  patternType: string,
  pattern: string,
  command: NormalizedShellCommand,
): boolean {
  switch (patternType) {
    case 'exact':
      return matchesExact(pattern, command);
    case 'prefix':
      return matchesPrefix(pattern, command);
    case 'program':
      return matchesProgram(pattern, command);
    case 'regex':
      return matchesRegex(pattern, command);
    default:
      return false;
  }
}
