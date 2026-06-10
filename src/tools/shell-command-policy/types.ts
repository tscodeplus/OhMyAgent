// src/tools/shell-command-policy/types.ts
//
// Shared types for shell command parsing, pattern matching, and classification.

export interface NormalizedShellCommand {
  raw: string;
  normalized: string;
  program: string;
  args: string[];
  containsSecrets: boolean;
}

export type PatternType = 'exact' | 'prefix' | 'program' | 'regex';

export interface AdbTemplate {
  pattern: string;
  patternType: PatternType;
  risk: 'low' | 'medium' | 'high';
  description: string;
}

export interface HardlinePatternEntry {
  pattern: string;
  type: 'exact' | 'prefix' | 'program' | 'regex';
  description: string;
}

export type HardlineCheckResult =
  | { blocked: true; pattern: string; description: string }
  | { blocked: false };

export interface DangerousPatternEntry {
  category: string;
  pattern: string;
  description: string;
}

export interface ProgramPolicy {
  safe: string[];
  warn: string[];
  denied: string[];
  ref?: string;
}

export interface CommandClassification {
  program: string;
  subcommandLabel: string;
  level: 'safe' | 'warn' | 'denied' | 'unknown';
}
