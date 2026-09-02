import { READ_ONLY_PROGRAMS } from './file-paths.js';
import { normalizeCommand, splitCommandSegments } from './parser.js';
import type { NormalizedShellCommand } from './types.js';

export function getReadOnlyShellBlockReason(command: string, toolsProfile: string): string | null {
  const segments = splitCommandSegments(command);
  for (const segment of segments) {
    if (!READ_ONLY_PROGRAMS.has(segment.program)) {
      return `Program "${segment.program}" is blocked by read-only shell mode (toolsProfile: ${toolsProfile})`;
    }

    const unsafeReason = getReadOnlyShellSegmentBlockReason(segment);
    if (unsafeReason) {
      return `${unsafeReason} is blocked by read-only shell mode (toolsProfile: ${toolsProfile})`;
    }
  }

  if (hasOutputRedirect(command)) {
    return `Output redirection is blocked by read-only shell mode (toolsProfile: ${toolsProfile})`;
  }

  const pipeReason = getReadOnlyShellPipeBlockReason(command);
  if (pipeReason) {
    return `${pipeReason} is blocked by read-only shell mode (toolsProfile: ${toolsProfile})`;
  }

  return null;
}

function getReadOnlyShellSegmentBlockReason(command: NormalizedShellCommand): string | null {
  const program = command.program.toLowerCase();
  const args = command.args.map((arg) => arg.toLowerCase());
  const raw = command.raw.toLowerCase();

  // ── Execution-vector checks (on the raw text: the shell executes these
  //    even inside double quotes, so quoted occurrences are blocked too) ──
  if (raw.includes('$(')) {
    return 'command substitution';
  }
  if (raw.includes('`')) {
    return 'command substitution (backticks)';
  }
  if (raw.includes('${')) {
    return 'variable expansion';
  }
  if (raw.includes('<(') || raw.includes('>(')) {
    return 'process substitution';
  }

  if (program === 'tee') {
    return 'tee writes files';
  }

  if (program === 'find') {
    if (args.includes('-delete')) {
      return 'find -delete';
    }
    const writeFlags = args.find((arg) => arg.startsWith('-fprint') || arg === '-fls');
    if (writeFlags) {
      return `find ${writeFlags}`;
    }
    const execIndex = args.findIndex(
      (arg) => arg === '-exec' || arg === '-execdir' || arg === '-ok' || arg === '-okdir',
    );
    if (execIndex !== -1) {
      // The executed program must itself be read-only (whitelist membership
      // instead of a hardcoded list: `find -exec tee`, `-exec env rm` etc.
      // are all covered this way).
      const executable = args[execIndex + 1] ?? '';
      if (executable && !READ_ONLY_PROGRAMS.has(executable)) {
        return `find ${args[execIndex]}`;
      }
    }
  }

  if (
    program === 'sort' &&
    args.some((arg) => arg.startsWith('-o') || arg.startsWith('--output'))
  ) {
    // startsWith covers the attached form `sort -ofile` (GNU allows it).
    return 'sort -o writes an output file';
  }

  if (program === 'date' && args.some((arg) => arg.startsWith('-s') || arg.startsWith('--set'))) {
    return 'date -s changes the system clock';
  }

  return null;
}

function getReadOnlyShellPipeBlockReason(command: string): string | null {
  const pipeTargets = getUnquotedPipeTargets(command);
  for (const target of pipeTargets) {
    if (/^tee(\s|$)/.test(target)) {
      return 'pipe to tee';
    }
    if (/^xargs(\s|$)/.test(target)) {
      // xargs is an arbitrary-execution launcher (e.g. `xargs -I{} sh -c ...`).
      return 'pipe to xargs';
    }
    // Every pipeline stage must itself be a read-only program. This closes
    // `cat a | bash`, `cat a | sed -i ...`, `echo x | xargs -0 rm` etc.
    const seg = normalizeCommand(target);
    if (!seg.program) continue;
    if (!READ_ONLY_PROGRAMS.has(seg.program)) {
      return `pipe to ${seg.program}`;
    }
    const unsafeReason = getReadOnlyShellSegmentBlockReason(seg);
    if (unsafeReason) {
      return unsafeReason;
    }
  }
  return null;
}

function getUnquotedPipeTargets(command: string): string[] {
  const targets: string[] = [];
  let inSingle = false;
  let inDouble = false;
  let escapeNext = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escapeNext = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === '|' && !inSingle && !inDouble && command[i + 1] !== '|') {
      targets.push(
        command
          .slice(i + 1)
          .trim()
          .toLowerCase(),
      );
    }
  }

  return targets;
}

function hasOutputRedirect(command: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;
    if (ch === '>') {
      if (i > 0 && (command[i - 1] === '-' || command[i - 1] === '=')) continue;
      return true;
    }
  }
  return false;
}
