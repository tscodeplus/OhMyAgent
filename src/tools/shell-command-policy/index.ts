// src/tools/shell-command-policy/index.ts
//
// Barrel exports — all public API from the sub-modules.

// Types
export type {
  NormalizedShellCommand,
  PatternType,
  AdbTemplate,
  HardlinePatternEntry,
  HardlineCheckResult,
  DangerousPatternEntry,
  ProgramPolicy,
  CommandClassification,
} from './types.js';

// Parser
export { normalizeCommand, splitCommandSegments } from './parser.js';

// Pattern matcher
export {
  matchesExact,
  matchesPrefix,
  matchesProgram,
  matchesRegex,
  matchesPattern,
} from './pattern-matcher.js';

// ADB templates
export { ADB_TEMPLATES } from './adb-templates.js';

// Hardline patterns
export { HARDLINE_PATTERNS, checkHardlineBlocklist } from './hardline-patterns.js';

// Dangerous patterns
export { DANGEROUS_PATTERNS, detectDangerousPatterns } from './dangerous-patterns.js';

// Safe subsets
export { SAFE_SUBSETS, classifyCommand } from './safe-subsets.js';
export { determineSubcommandLabel } from './safe-subsets.js';

// File paths
export { READ_ONLY_PROGRAMS } from './file-paths.js';
export { extractFilePaths, resolveFilePath, checkFilePathsOutsideRoots } from './file-paths.js';

// Read-only shell profile checks
export { getReadOnlyShellBlockReason } from './read-only-shell.js';

// Command risk assessment
export { assessCommandRisk } from './command-risk.js';
export type { CommandRisk } from './command-risk.js';
