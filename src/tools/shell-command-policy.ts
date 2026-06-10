/**
 * Shell command policy — normalization, pattern matching, ADB templates,
 * and file path checking.
 *
 * Re-exports from the shell-command-policy/ sub-modules.
 * Kept as a barrel file for backward compatibility with existing imports.
 */

export type {
  NormalizedShellCommand,
  PatternType,
  AdbTemplate,
  HardlinePatternEntry,
  HardlineCheckResult,
  DangerousPatternEntry,
  ProgramPolicy,
  CommandClassification,
} from './shell-command-policy/types.js';

export {
  normalizeCommand,
  splitCommandSegments,
  matchesExact,
  matchesPrefix,
  matchesProgram,
  matchesRegex,
  matchesPattern,
  ADB_TEMPLATES,
  HARDLINE_PATTERNS,
  checkHardlineBlocklist,
  DANGEROUS_PATTERNS,
  detectDangerousPatterns,
  SAFE_SUBSETS,
  classifyCommand,
  READ_ONLY_PROGRAMS,
  getReadOnlyShellBlockReason,
  extractFilePaths,
  resolveFilePath,
  checkFilePathsOutsideRoots,
  assessCommandRisk,
} from './shell-command-policy/index.js';

export type { CommandRisk } from './shell-command-policy/index.js';

export { determineSubcommandLabel } from './shell-command-policy/safe-subsets.js';
