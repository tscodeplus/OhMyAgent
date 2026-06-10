// src/tools/shell-command-policy/safe-subsets.ts
//
// Per-program policy tiers and command classification.

import type { ProgramPolicy, CommandClassification, NormalizedShellCommand } from './types.js';


export const SAFE_SUBSETS: Record<string, ProgramPolicy> = {

  // ── Network ──
  'curl': {
    safe: ['get'],
    warn: ['post', 'put', 'patch', 'delete', 'download'],
    denied: ['pipe'],
  },
  'wget': {
    safe: ['spider'],
    warn: ['download'],
    denied: ['pipe', 'output-stdout'],
  },

  // ── Git ──
  'git': {
    safe: ['status', 'log', 'diff', 'branch', 'show', 'stash-list',
           'tag-list', 'remote-show', 'config-list', 'rev-parse', 'describe', 'ls-files'],
    warn: ['add', 'commit', 'checkout', 'merge', 'pull', 'push',
           'rebase', 'stash-push', 'stash-pop', 'cherry-pick', 'fetch',
           'clone-shallow', 'tag-create', 'remote-add', 'init', 'mv', 'rm'],
    denied: ['push-force', 'reset-hard', 'clean-force', 'branch-delete-force',
             'rebase-force', 'reflog-delete', 'filter-branch'],
  },

  // ── Python ──
  'python': {
    safe: ['version', 'check'],
    warn: ['script', 'module'],
    denied: ['inline', 'pipe'],
  },
  'python3': { safe: [], warn: [], denied: [], ref: 'python' },
  'pip': {
    safe: ['list', 'show', 'freeze', 'check', 'cache-list'],
    warn: ['install', 'download', 'wheel'],
    denied: ['uninstall'],
  },
  'pip3': { safe: [], warn: [], denied: [], ref: 'pip' },

  // ── Node.js ──
  'node': {
    safe: ['version', 'eval-safe'],
    warn: ['script', 'require'],
    denied: ['eval-dangerous', 'pipe'],
  },
  'npm': {
    safe: ['list', 'outdated', 'view', 'info', 'search', 'docs', 'repo'],
    warn: ['install', 'ci', 'update', 'audit-fix', 'rebuild', 'fund'],
    denied: ['uninstall', 'prune', 'cache-clean'],
  },
  'npx': {
    safe: [],
    warn: ['info', 'version'],
    denied: ['exec'],
  },
  'pnpm': { safe: [], warn: [], denied: [], ref: 'npm' },
  'yarn': { safe: [], warn: [], denied: [], ref: 'npm' },

  // ── Rust / Go ──
  'cargo': {
    safe: ['check', 'build', 'test', 'doc', 'fmt-check', 'clippy'],
    warn: ['run', 'install', 'publish', 'update'],
    denied: ['clean', 'uninstall'],
  },
  'rustup': {
    safe: ['show', 'check', 'list'],
    warn: ['update', 'install', 'target-add'],
    denied: ['uninstall', 'default-set'],
  },
  'go': {
    safe: ['version', 'env', 'list', 'doc', 'fmt', 'vet'],
    warn: ['build', 'test', 'run', 'get', 'mod-tidy', 'mod-download'],
    denied: ['clean-cache'],
  },

  // ── Docker ──
  'docker': {
    safe: ['ps', 'images', 'info', 'version', 'inspect', 'logs', 'stats', 'top'],
    warn: ['start', 'stop', 'restart', 'pull', 'build', 'exec', 'compose-up'],
    denied: ['rm', 'rmi', 'prune', 'system-prune', 'compose-down-volumes'],
  },

  // ── Package managers ──
  'apt': {
    safe: ['list', 'search', 'show', 'policy'],
    warn: ['install', 'update', 'upgrade', 'full-upgrade', 'autoremove'],
    denied: ['remove', 'purge'],
  },
  'apt-get': { safe: [], warn: [], denied: [], ref: 'apt' },
  'pkg': {
    safe: ['list', 'search', 'show', 'files', 'list-all'],
    warn: ['install', 'update', 'upgrade'],
    denied: ['uninstall'],
  },

  // ── File operations ──
  'cp': {
    safe: [],
    warn: ['copy'],
    denied: ['recursive-system', 'force-system'],
  },
  'mv': {
    safe: [],
    warn: ['rename'],
    denied: ['system-dir'],
  },
  'mkdir': {
    safe: ['create'],
    warn: ['recursive'],
    denied: [],
  },
  'touch': {
    safe: ['safe-op'],
    warn: [],
    denied: [],
  },
  'diff': {
    safe: ['safe-op'],
    warn: [],
    denied: [],
  },
  'sed': {
    safe: ['process'],
    warn: ['edit-in-place'],
    denied: ['system-file'],
  },
  'awk': {
    safe: ['process'],
    warn: ['edit-in-place'],
    denied: [],
  },
  // editors
  'nano': {
    safe: [],
    warn: ['edit'],
    denied: ['system-file'],
  },
  'vim': {
    safe: [],
    warn: ['edit'],
    denied: ['system-file'],
  },
  'vi': { safe: [], warn: [], denied: [], ref: 'vim' },
  // network diagnostics
  'ping': {
    safe: ['diagnostic'],
    warn: [],
    denied: ['flood'],
  },
  'ping6': { safe: [], warn: [], denied: [], ref: 'ping' },
  // disk usage
  'du': {
    safe: ['safe-op'],
    warn: [],
    denied: [],
  },
  'df': {
    safe: ['safe-op'],
    warn: [],
    denied: [],
  },
  // file info
  'file': {
    safe: ['safe-op'],
    warn: [],
    denied: [],
  },
  'stat': {
    safe: ['safe-op'],
    warn: [],
    denied: [],
  },
  'md5sum': {
    safe: ['safe-op'],
    warn: [],
    denied: [],
  },
  'sha256sum': {
    safe: ['safe-op'],
    warn: [],
    denied: [],
  },
  'sha1sum': { safe: [], warn: [], denied: [], ref: 'md5sum' },
  'realpath': {
    safe: ['safe-op'],
    warn: [],
    denied: [],
  },
  'basename': {
    safe: ['safe-op'],
    warn: [],
    denied: [],
  },
  'dirname': {
    safe: ['safe-op'],
    warn: [],
    denied: [],
  },
  'ln': {
    safe: [],
    warn: ['symbolic'],
    denied: ['force-system'],
  },
  'tee': {
    safe: [],
    warn: ['write'],
    denied: ['system-file', 'append-system'],
  },
  'tar': {
    safe: ['list'],
    warn: ['extract', 'create'],
    denied: ['extract-absolute'],
  },
  'rsync': {
    safe: ['dry-run', 'list'],
    warn: ['sync'],
    denied: ['delete', 'delete-source'],
  },
  'chmod': {
    safe: ['read'],
    warn: ['exec'],
    denied: ['permissive'],
  },
  'chown': {
    safe: ['user'],
    warn: ['recursive'],
    denied: ['root', 'system'],
  },

  // ── System / Process ──
  'systemctl': {
    safe: ['status', 'list', 'is-active', 'is-enabled', 'show', 'cat'],
    warn: ['start', 'stop', 'restart', 'reload', 'enable', 'disable'],
    denied: ['mask', 'unmask', 'daemon-reload'],
  },
  'pm2': {
    safe: ['status', 'list', 'show', 'logs', 'monit', 'info', 'describe'],
    warn: ['start', 'stop', 'restart', 'reload', 'save'],
    denied: ['delete', 'kill', 'flush', 'reset'],
  },
  'kill': {
    safe: [],
    warn: ['signal-safe'],
    denied: ['force-all', 'signal-dangerous'],
  },

  // ── Databases ──
  'sqlite3': {
    safe: ['read'],
    warn: ['import'],
    denied: ['write-destructive'],
  },
  'psql': {
    safe: ['list', 'info'],
    warn: ['connect', 'query'],
    denied: ['drop', 'truncate'],
  },
  'mysql': {
    safe: ['show', 'describe'],
    warn: ['select', 'connect'],
    denied: ['drop', 'truncate', 'delete-all'],
  },

  // ── SSH ──
  'ssh': {
    safe: ['version', 'key-scan'],
    warn: ['connect'],
    denied: ['tunnel', 'forward', 'command-exec'],
  },
  'scp': {
    safe: [],
    warn: ['upload', 'download'],
    denied: ['recursive-system'],
  },

  // ── Media ──
  'ffmpeg': {
    safe: ['info', 'probe'],
    warn: ['convert', 'compress'],
    denied: ['record', 'stream'],
  },
  'ffprobe': { safe: ['probe'], warn: [], denied: [] },

  // ── Compression ──
  'zip':    { safe: ['list'], warn: ['create', 'extract'], denied: ['overwrite'] },
  'unzip':  { safe: ['list', 'test'], warn: ['extract'], denied: ['overwrite'] },
  'gzip':   { safe: ['list', 'test'], warn: ['compress', 'decompress'], denied: ['force-overwrite'] },
};

export function classifyCommand(
  command: NormalizedShellCommand,
  userAllowlist: Set<string>,
): CommandClassification {
  const program = command.program.toLowerCase();
  const policy = SAFE_SUBSETS[program];

  // Resolve ref alias
  const resolved: ProgramPolicy | undefined = policy?.ref
    ? SAFE_SUBSETS[policy.ref]
    : policy;

  // Determine subcommand label from args
  const subcommandLabel = determineSubcommandLabel(command, resolved);

  // If bare program is in user allowlist, everything is safe
  if (userAllowlist.has(program)) {
    return { program, subcommandLabel: '*', level: 'safe' };
  }

  // Check if specific subcommand is in user allowlist
  if (userAllowlist.has(`${program}:${subcommandLabel}`)) {
    return { program, subcommandLabel, level: 'safe' };
  }

  if (!resolved) {
    return { program, subcommandLabel: 'unknown', level: 'unknown' };
  }

  // Classify against policy tiers
  if (resolved.denied.includes(subcommandLabel)) {
    return { program, subcommandLabel, level: 'denied' };
  }
  if (resolved.warn.includes(subcommandLabel)) {
    return { program, subcommandLabel, level: 'warn' };
  }
  if (resolved.safe.includes(subcommandLabel)) {
    return { program, subcommandLabel, level: 'safe' };
  }

  return { program, subcommandLabel, level: 'unknown' };
}

/**
 * Determine which subcommand label a command maps to by checking
 * command arguments against common patterns.
 */
export function determineSubcommandLabel(
  command: NormalizedShellCommand,
  policy?: ProgramPolicy,
): string {
  const args = command.args;
  const raw = command.raw.toLowerCase();

  // Helper: check if args contain a specific flag
  const hasFlag = (flag: string): boolean =>
    raw.includes(` ${flag}`) || raw.includes(` ${flag} `) || raw.endsWith(` ${flag}`);

  // git-specific
  if (command.program === 'git') {
    const sub = args[0] ?? '';
    if (sub === 'push' && hasFlag('-f') || hasFlag('--force')) return 'push-force';
    if (sub === 'reset' && hasFlag('--hard')) return 'reset-hard';
    if (sub === 'clean' && (hasFlag('-f') || hasFlag('--force'))) return 'clean-force';
    if (sub === 'branch' && hasFlag('-D')) return 'branch-delete-force';
    if (sub === 'rebase' && (hasFlag('--force') || hasFlag('-f'))) return 'rebase-force';
    if (sub === 'stash' && (args[1] === 'push' || args[1] === 'save')) return 'stash-push';
    if (sub === 'stash' && args[1] === 'pop') return 'stash-pop';
    if (sub === 'stash' && args[1] === 'list') return 'stash-list';
    if (sub === 'tag' && (args[1] === '-l' || args[1] === '--list' || !args[1])) return 'tag-list';
    if (sub === 'tag') return 'tag-create';
    if (sub === 'remote' && (args[1] === 'show' || args[1] === '-v')) return 'remote-show';
    if (sub === 'remote' && (args[1] === 'add')) return 'remote-add';
    if (sub === 'config' && (args[1] === '--list' || args[1] === '-l')) return 'config-list';
    if (sub === 'clone' && hasFlag('--depth')) return 'clone-shallow';
    if (sub === 'clone') return 'clone-shallow';
    if (sub === 'ls-files') return 'ls-files';
    if (sub) return sub;
    return 'unknown';
  }

  // curl-specific
  if (command.program === 'curl' || command.program === 'wget') {
    if (raw.includes('|')) return 'pipe';
    if (hasFlag('-o') || hasFlag('--output') || hasFlag('-O') || hasFlag('--remote-name')) return 'download';
    if (hasFlag('-X') && (raw.includes('POST') || raw.includes(' PUT '))) return 'post';
    if (hasFlag('--spider') || hasFlag('-I') || hasFlag('--head')) return 'spider';
    if (hasFlag('-X') && raw.includes('DELETE')) return 'delete';
    if (hasFlag('-O') && hasFlag('-')) return 'output-stdout';
    return 'get';
  }

  // python-specific
  if (command.program === 'python' || command.program === 'python3') {
    if (hasFlag('--version') || hasFlag('-V')) return 'version';
    if (hasFlag('--check')) return 'check';
    if (hasFlag('-c')) return 'inline';
    if (hasFlag('-m')) return 'module';
    if (raw.includes('|')) return 'pipe';
    return 'script';
  }

  // node-specific
  if (command.program === 'node') {
    if (hasFlag('--version') || hasFlag('-v')) return 'version';
    if (hasFlag('-e') && !raw.includes('require') && !raw.includes('fs') && !raw.includes('child_process')) return 'eval-safe';
    if (hasFlag('-e')) return 'eval-dangerous';
    if (raw.includes('|')) return 'pipe';
    return 'script';
  }

  // npm/pnpm/yarn
  if (['npm', 'pnpm', 'yarn', 'npx'].includes(command.program)) {
    const sub = args[0] ?? '';
    if (sub === 'ls' || sub === 'list') return 'list';
    if (sub === 'install' || sub === 'i') return 'install';
    if (sub === 'uninstall' || sub === 'un' || sub === 'remove' || sub === 'rm') return 'uninstall';
    if (sub === 'ci') return 'ci';
    if (sub === 'update' || sub === 'up') return 'update';
    if (sub === 'outdated') return 'outdated';
    if (sub === 'view' || sub === 'info') return 'view';
    if (sub === 'search') return 'search';
    if (sub === 'docs') return 'docs';
    if (sub === 'repo') return 'repo';
    if (sub === 'audit' && hasFlag('--fix')) return 'audit-fix';
    if (sub === 'rebuild') return 'rebuild';
    if (sub === 'fund') return 'fund';
    if (sub === 'prune') return 'prune';
    if (sub === 'cache' && (args[1] === 'clean' || args[1] === 'clear')) return 'cache-clean';
    if (sub === 'doctor') return 'doctor';
    if (command.program === 'npx') return 'exec';
    return sub || 'unknown';
  }

  // cargo
  if (command.program === 'cargo') {
    const sub = args[0] ?? '';
    if (sub === 'check') return 'check';
    if (sub === 'build') return 'build';
    if (sub === 'test') return 'test';
    if (sub === 'doc') return 'doc';
    if (sub === 'fmt' && hasFlag('--check')) return 'fmt-check';
    if (sub === 'clippy') return 'clippy';
    if (sub === 'run') return 'run';
    if (sub === 'install') return 'install';
    if (sub === 'publish') return 'publish';
    if (sub === 'update') return 'update';
    if (sub === 'clean') return 'clean';
    if (sub === 'uninstall') return 'uninstall';
    return sub || 'unknown';
  }

  // docker
  if (command.program === 'docker') {
    const sub = args[0] ?? '';
    if (sub === 'ps') return 'ps';
    if (sub === 'images') return 'images';
    if (sub === 'info') return 'info';
    if (sub === 'version') return 'version';
    if (sub === 'inspect') return 'inspect';
    if (sub === 'logs') return 'logs';
    if (sub === 'stats') return 'stats';
    if (sub === 'top') return 'top';
    if (sub === 'start') return 'start';
    if (sub === 'stop') return 'stop';
    if (sub === 'restart') return 'restart';
    if (sub === 'pull') return 'pull';
    if (sub === 'build') return 'build';
    if (sub === 'exec') return 'exec';
    if (sub === 'compose' && args[1] === 'up') return 'compose-up';
    if (sub === 'compose' && (args[1] === 'down' && hasFlag('-v'))) return 'compose-down-volumes';
    if (sub === 'compose') return 'compose-up';
    if (sub === 'rm') return 'rm';
    if (sub === 'rmi') return 'rmi';
    if (sub === 'prune') return 'prune';
    if (sub === 'system' && args[1] === 'prune') return 'system-prune';
    return sub || 'unknown';
  }

  // tar/zip-specific: map flags to operations
  if (['tar', 'gzip', 'zip', 'unzip', '7z'].includes(command.program)) {
    if (hasFlag('-t') || hasFlag('--list')) return 'list';
    if (hasFlag('-x') || hasFlag('--extract')) return 'extract';
    if (hasFlag('-c') || hasFlag('--create')) return 'create';
    if (hasFlag('--delete')) return 'delete';
    if (hasFlag('-z') || hasFlag('--gzip')) return 'extract';
    if (hasFlag('-j') || hasFlag('--bzip2')) return 'extract';
    if (hasFlag('-f') || hasFlag('--force')) return 'force-overwrite';
    return args[0] ?? 'unknown';
  }

  // cp/mv/ln: first arg is always a path, classify by target
  if (command.program === 'cp') {
    if (hasFlag('-r') || hasFlag('-R') || hasFlag('--recursive')) {
      if (/\/etc\b|\/usr\b|\/bin\b|\/boot\b/.test(raw)) return 'recursive-system';
      return 'copy';
    }
    if (hasFlag('-f') || hasFlag('--force')) {
      if (/\/etc\b|\/usr\b|\/bin\b/.test(raw)) return 'force-system';
      return 'copy';
    }
    return 'copy';
  }
  if (command.program === 'mv') {
    if (/\/etc\b|\/usr\b|\/bin\b|\/boot\b/.test(raw)) return 'system-dir';
    return 'rename';
  }
  if (command.program === 'mkdir') {
    if (hasFlag('-p') || hasFlag('--parents')) return 'recursive';
    return 'create';
  }
  // sed/awk: detect in-place editing on system files
  if (command.program === 'sed') {
    if (hasFlag('-i') || hasFlag('--in-place')) {
      if (/\/etc\b|\/usr\b/.test(raw)) return 'system-file';
      return 'edit-in-place';
    }
    return 'process';
  }
  if (command.program === 'awk') {
    if (hasFlag('-i') || hasFlag('--in-place')) return 'edit-in-place';
    return 'process';
  }
  // touch / diff / file / stat / du / df: always safe read or trivial write
  if (['touch', 'diff', 'file', 'stat', 'du', 'df', 'basename', 'dirname', 'realpath', 'md5sum', 'sha256sum', 'sha1sum'].includes(command.program)) {
    return 'safe-op';
  }
  // ping: safe network diagnostic
  if (['ping', 'ping6'].includes(command.program)) {
    if (hasFlag('-f') || hasFlag('--flood')) return 'flood';
    return 'diagnostic';
  }
  // ln: link creation
  if (command.program === 'ln') {
    if (hasFlag('-s') || hasFlag('--symbolic')) {
      if (/\/etc\b|\/usr\b|\/bin\b/.test(raw)) return 'force-system';
      return 'symbolic';
    }
    return 'symbolic';
  }
  // tee: write to file, check target
  if (command.program === 'tee') {
    if (hasFlag('-a') || hasFlag('--append')) {
      if (/\/etc\b|\/usr\b/.test(raw)) return 'append-system';
      return 'write';
    }
    if (/\/etc\b|\/usr\b/.test(raw)) return 'system-file';
    return 'write';
  }
  // editors: check target
  if (['nano', 'vim', 'vi'].includes(command.program)) {
    if (/\/etc\b|\/usr\b/.test(raw)) return 'system-file';
    return 'edit';
  }

  // Default: use first arg as subcommand
  const sub = args[0] ?? '';
  if (!sub) return 'unknown';

  if (policy) {
    if (policy.denied.includes(sub)) return sub;
    if (policy.warn.includes(sub)) return sub;
    if (policy.safe.includes(sub)) return sub;
  }

  return sub;
}
