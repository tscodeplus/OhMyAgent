// src/tools/shell-command-policy/parser.ts
//
// Shell command parsing utilities: tokenize, normalize, and segment chained commands.

import type { NormalizedShellCommand } from './types.js';

function parseCommandParts(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escapeNext = false;

  for (const ch of command) {
    if (escapeNext) {
      current += ch;
      escapeNext = false;
      continue;
    }

    if (ch === '\\' && !inSingleQuote) {
      escapeNext = true;
      continue;
    }

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (ch === ' ' && !inSingleQuote && !inDoubleQuote) {
      if (current.length > 0) {
        parts.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    parts.push(current);
  }

  return parts;
}

function stripCommentOnlyLines(command: string): string {
  return command
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
    .join('\n');
}

function detectSecretsInCommand(command: string): boolean {
  const secretPatterns = [
    /password\s*=\s*\S+/i,
    /--password\s+\S+/i,
    /-p\s+\S+/i,
    /token\s*=\s*\S+/i,
    /api[_-]?key\s*=\s*\S+/i,
    /apikey\s*=\s*\S+/i,
    /secret\s*=\s*\S+/i,
    /Authorization:\s*Bearer\s+\S+/i,
  ];
  return secretPatterns.some((p) => p.test(command));
}

export function normalizeCommand(rawCommand: string): NormalizedShellCommand {
  const trimmed = rawCommand.trim();
  const normalized = trimmed.replace(/\s+/g, ' ');

  const parts = parseCommandParts(normalized);
  const program = parts[0] ?? '';
  const args = parts.slice(1);

  const containsSecrets = detectSecretsInCommand(normalized);

  return {
    raw: rawCommand,
    normalized,
    program,
    args,
    containsSecrets,
  };
}

export function splitCommandSegments(rawCommand: string): NormalizedShellCommand[] {
  const sanitized = stripCommentOnlyLines(rawCommand);
  if (!sanitized) return [];

  const segments: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escapeNext = false;

  for (let i = 0; i < sanitized.length; i++) {
    const ch = sanitized[i];
    const next = sanitized[i + 1];

    if (escapeNext) {
      current += ch;
      escapeNext = false;
      continue;
    }

    if (ch === '\\' && !inSingleQuote) {
      escapeNext = true;
      current += ch;
      continue;
    }

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += ch;
      continue;
    }

    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote) {
      if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
        const trimmed = current.trim();
        if (trimmed) segments.push(trimmed);
        current = '';
        i++;
        continue;
      }

      if (ch === ';') {
        const trimmed = current.trim();
        if (trimmed) segments.push(trimmed);
        current = '';
        continue;
      }
    }

    current += ch;
  }

  const trimmed = current.trim();
  if (trimmed) segments.push(trimmed);

  return segments.map(segment => normalizeCommand(segment));
}
