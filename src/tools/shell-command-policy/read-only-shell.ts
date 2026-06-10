import { READ_ONLY_PROGRAMS } from './file-paths.js';
import { splitCommandSegments } from './parser.js';

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

function getReadOnlyShellSegmentBlockReason(command: { program: string; args: string[] }): string | null {
  const program = command.program.toLowerCase();
  const args = command.args.map(arg => arg.toLowerCase());

  if (program === 'tee') {
    return 'tee writes files';
  }

  if (program === 'find') {
    if (args.includes('-delete')) {
      return 'find -delete';
    }
    const execIndex = args.findIndex(arg => arg === '-exec' || arg === '-execdir' || arg === '-ok' || arg === '-okdir');
    if (execIndex !== -1) {
      const executable = args[execIndex + 1] ?? '';
      if (['rm', 'rmdir', 'mv', 'cp', 'sh', 'bash', 'zsh', 'python', 'python3', 'node', 'perl'].includes(executable)) {
        return `find ${args[execIndex]}`;
      }
    }
  }

  return null;
}

function getReadOnlyShellPipeBlockReason(command: string): string | null {
  const pipeTargets = getUnquotedPipeTargets(command);
  for (const target of pipeTargets) {
    if (/^tee(\s|$)/.test(target)) {
      return 'pipe to tee';
    }
    if (/^xargs\s+(rm|rmdir|mv|cp|sh|bash|zsh|python|python3|node|perl)(\s|$)/.test(target)) {
      return 'pipe to mutating xargs command';
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
      targets.push(command.slice(i + 1).trim().toLowerCase());
    }
  }

  return targets;
}

function hasOutputRedirect(command: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (inSingle || inDouble) continue;
    if (ch === '>') {
      if (i > 0 && (command[i - 1] === '-' || command[i - 1] === '=')) continue;
      return true;
    }
  }
  return false;
}
