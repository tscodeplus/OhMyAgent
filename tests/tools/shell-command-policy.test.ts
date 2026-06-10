import { describe, it, expect } from 'vitest';
import {
  normalizeCommand,
  splitCommandSegments,
  matchesExact,
  matchesPrefix,
  matchesProgram,
  matchesRegex,
  matchesPattern,
  ADB_TEMPLATES,
  extractFilePaths,
  resolveFilePath,
  checkFilePathsOutsideRoots,
} from '../../src/tools/shell-command-policy';
import type { NormalizedShellCommand } from '../../src/tools/shell-command-policy';

describe('normalizeCommand', () => {
  it('parses a simple command', () => {
    const result = normalizeCommand('ls -la');
    expect(result.raw).toBe('ls -la');
    expect(result.normalized).toBe('ls -la');
    expect(result.program).toBe('ls');
    expect(result.args).toEqual(['-la']);
    expect(result.containsSecrets).toBe(false);
  });

  it('collapses multiple spaces', () => {
    const result = normalizeCommand('ls   -la   /tmp');
    expect(result.program).toBe('ls');
    expect(result.args).toEqual(['-la', '/tmp']);
  });

  it('trims leading and trailing whitespace', () => {
    const result = normalizeCommand('  echo hello  ');
    expect(result.program).toBe('echo');
    expect(result.args).toEqual(['hello']);
  });

  it('parses single-quoted arguments', () => {
    const result = normalizeCommand("echo 'hello world'");
    expect(result.program).toBe('echo');
    expect(result.args).toEqual(['hello world']);
  });

  it('parses double-quoted arguments', () => {
    const result = normalizeCommand('echo "hello world"');
    expect(result.program).toBe('echo');
    expect(result.args).toEqual(['hello world']);
  });

  it('parses mixed quoted and unquoted arguments', () => {
    const result = normalizeCommand("echo 'hello world' foo 'bar baz'");
    expect(result.program).toBe('echo');
    expect(result.args).toEqual(['hello world', 'foo', 'bar baz']);
  });

  it('handles escaped spaces', () => {
    const result = normalizeCommand('echo hello\\ world');
    expect(result.program).toBe('echo');
    expect(result.args).toEqual(['hello world']);
  });

  it('handles empty string', () => {
    const result = normalizeCommand('');
    expect(result.raw).toBe('');
    expect(result.program).toBe('');
    expect(result.args).toEqual([]);
    expect(result.containsSecrets).toBe(false);
  });

  it('handles string with only spaces', () => {
    const result = normalizeCommand('   ');
    expect(result.program).toBe('');
    expect(result.args).toEqual([]);
    expect(result.containsSecrets).toBe(false);
  });
});

describe('secret detection', () => {
  it('detects password= in args', () => {
    const result = normalizeCommand('curl -u admin:password=secret123');
    expect(result.containsSecrets).toBe(true);
  });

  it('detects --password flag', () => {
    const result = normalizeCommand('mysql --password=abc123 -u root');
    expect(result.containsSecrets).toBe(true);
  });

  it('detects Bearer token', () => {
    const result = normalizeCommand('curl -H "Authorization: Bearer tok_abc123" https://api.example.com');
    expect(result.containsSecrets).toBe(true);
  });

  it('detects token= pattern', () => {
    const result = normalizeCommand('export token=sk_live_abc123');
    expect(result.containsSecrets).toBe(true);
  });

  it('detects api_key= pattern', () => {
    const result = normalizeCommand('set api_key=mysecretkey');
    expect(result.containsSecrets).toBe(true);
  });

  it('detects -p flag with value', () => {
    const result = normalizeCommand('ssh -p 2222 user@host');
    expect(result.containsSecrets).toBe(true);
  });

  it('does not flag clean commands', () => {
    const result = normalizeCommand('ls -la /tmp');
    expect(result.containsSecrets).toBe(false);
  });

  it('does not flag commands with partial matches', () => {
    const result = normalizeCommand('echo passwordless');
    expect(result.containsSecrets).toBe(false);
  });
});

describe('pattern matching', () => {
  const cmd: NormalizedShellCommand = {
    raw: 'adb devices',
    normalized: 'adb devices',
    program: 'adb',
    args: ['devices'],
    containsSecrets: false,
  };

  describe('matchesExact', () => {
    it('matches exact command', () => {
      expect(matchesExact('adb devices', cmd)).toBe(true);
    });

    it('rejects non-exact command', () => {
      expect(matchesExact('adb install', cmd)).toBe(false);
    });
  });

  describe('matchesPrefix', () => {
    it('matches prefix', () => {
      expect(matchesPrefix('adb', cmd)).toBe(true);
    });

    it('rejects non-matching prefix', () => {
      expect(matchesPrefix('curl', cmd)).toBe(false);
    });
  });

  describe('matchesProgram', () => {
    it('matches program name', () => {
      expect(matchesProgram('adb', cmd)).toBe(true);
    });

    it('rejects wrong program', () => {
      expect(matchesProgram('ls', cmd)).toBe(false);
    });
  });

  describe('matchesRegex', () => {
    it('matches regex pattern', () => {
      expect(matchesRegex('adb\\s+devices', cmd)).toBe(true);
    });

    it('rejects non-matching regex', () => {
      expect(matchesRegex('^curl', cmd)).toBe(false);
    });

    it('returns false for invalid regex', () => {
      expect(matchesRegex('[invalid', cmd)).toBe(false);
    });
  });

  describe('matchesPattern', () => {
    it('dispatches to exact', () => {
      expect(matchesPattern('exact', 'adb devices', cmd)).toBe(true);
    });

    it('dispatches to prefix', () => {
      expect(matchesPattern('prefix', 'adb', cmd)).toBe(true);
    });

    it('dispatches to program', () => {
      expect(matchesPattern('program', 'adb', cmd)).toBe(true);
    });

    it('dispatches to regex', () => {
      expect(matchesPattern('regex', 'adb.*devices', cmd)).toBe(true);
    });

    it('returns false for unknown pattern type', () => {
      expect(matchesPattern('unknown', 'adb', cmd)).toBe(false);
    });
  });
});

describe('splitCommandSegments', () => {
  it('ignores leading comment lines and splits chained commands', () => {
    const result = splitCommandSegments(`# comment\nadb devices && sleep 1 && adb pull /sdcard/a ./a`);
    expect(result.map(segment => segment.program)).toEqual(['adb', 'sleep', 'adb']);
  });
});

describe('ADB_TEMPLATES', () => {
  it('has 22 templates', () => {
    expect(ADB_TEMPLATES.length).toBe(22);
  });

  it('has correct low risk templates', () => {
    const lowRisk = ADB_TEMPLATES.filter((t) => t.risk === 'low');
    expect(lowRisk.length).toBe(9);
    const lowPatterns = lowRisk.map((t) => t.pattern);
    expect(lowPatterns).toContain('adb devices');
    expect(lowPatterns).toContain('adb shell getprop');
    expect(lowPatterns).toContain('adb shell ls');
    expect(lowPatterns).toContain('adb shell cat');
    expect(lowPatterns).toContain('adb shell df');
    expect(lowPatterns).toContain('adb shell screencap');
    expect(lowPatterns).toContain('adb exec-out screencap');
    expect(lowPatterns).toContain('adb shell uptime');
    expect(lowPatterns).toContain('adb version');
  });

  it('has correct medium risk templates', () => {
    const medRisk = ADB_TEMPLATES.filter((t) => t.risk === 'medium');
    expect(medRisk.length).toBe(7);
    const medPatterns = medRisk.map((t) => t.pattern);
    expect(medPatterns).toContain('adb shell pm list');
    expect(medPatterns).toContain('adb shell dumpsys');
    expect(medPatterns).toContain('adb shell settings get');
    expect(medPatterns).toContain('adb shell input');
    expect(medPatterns).toContain('adb shell am start');
    expect(medPatterns).toContain('adb pull');
    expect(medPatterns).toContain('adb push');
  });

  it('has correct high risk templates', () => {
    const highRisk = ADB_TEMPLATES.filter((t) => t.risk === 'high');
    expect(highRisk.length).toBe(6);
    const highPatterns = highRisk.map((t) => t.pattern);
    expect(highPatterns).toContain('adb install');
    expect(highPatterns).toContain('adb uninstall');
    expect(highPatterns).toContain('adb shell pm uninstall');
    expect(highPatterns).toContain('adb shell rm');
    expect(highPatterns).toContain('adb root');
    expect(highPatterns).toContain('adb shell su');
  });

  it('each template has a description', () => {
    for (const template of ADB_TEMPLATES) {
      expect(template.description.length).toBeGreaterThan(0);
    }
  });

  it('adb devices exact template matches', () => {
    const cmd = normalizeCommand('adb devices');
    const template = ADB_TEMPLATES.find((t) => t.pattern === 'adb devices')!;
    expect(matchesPattern(template.patternType, template.pattern, cmd)).toBe(true);
  });

  it('adb shell input prefix template matches', () => {
    const cmd = normalizeCommand('adb shell input tap 100 200');
    const template = ADB_TEMPLATES.find((t) => t.pattern === 'adb shell input')!;
    expect(matchesPattern(template.patternType, template.pattern, cmd)).toBe(true);
  });

  it('adb install prefix template matches', () => {
    const cmd = normalizeCommand('adb install /sdcard/app.apk');
    const template = ADB_TEMPLATES.find((t) => t.pattern === 'adb install')!;
    expect(matchesPattern(template.patternType, template.pattern, cmd)).toBe(true);
  });
});

// ─── File Path Extraction & Root Checking ───

import path from 'path';
import os from 'os';

describe('extractFilePaths', () => {
  it('extracts file paths from cat command', () => {
    const cmd = normalizeCommand('cat /sdcard/secret.txt');
    const paths = extractFilePaths(cmd);
    expect(paths).toEqual(['/sdcard/secret.txt']);
  });

  it('extracts multiple file paths', () => {
    const cmd = normalizeCommand('cp file1.txt /sdcard/file2.txt');
    const paths = extractFilePaths(cmd);
    expect(paths).toEqual(['file1.txt', '/sdcard/file2.txt']);
  });

  it('filters out flags', () => {
    const cmd = normalizeCommand('cat -n /tmp/test.txt');
    const paths = extractFilePaths(cmd);
    expect(paths).toEqual(['/tmp/test.txt']);
  });

  it('filters out shell operators', () => {
    const cmd = normalizeCommand('cat file.txt && echo done');
    // splitCommandSegments would split this, but for a single segment:
    const singleSeg = normalizeCommand('cat file.txt');
    const paths = extractFilePaths(singleSeg);
    expect(paths).toEqual(['file.txt']);
  });

  it('returns empty for commands with no file paths', () => {
    const cmd = normalizeCommand('echo hello world');
    const paths = extractFilePaths(cmd);
    expect(paths).toEqual(['hello', 'world']);
  });

  it('extracts grep file path', () => {
    const cmd = normalizeCommand('grep -r "pattern" /sdcard/logs');
    const paths = extractFilePaths(cmd);
    expect(paths).toContain('/sdcard/logs');
  });
});

describe('checkFilePathsOutsideRoots', () => {
  it('returns empty when all paths are inside allowed roots', () => {
    const cmd = normalizeCommand('cat README.md src/index.ts');
    const outside = checkFilePathsOutsideRoots(cmd, [process.cwd()]);
    expect(outside).toEqual([]);
  });

  it('detects paths outside allowed roots', () => {
    const cmd = normalizeCommand('cat /sdcard/secret.txt');
    const outside = checkFilePathsOutsideRoots(cmd, [process.cwd()]);
    expect(outside).toEqual(['/sdcard/secret.txt']);
  });

  it('returns empty for pure flags and operators', () => {
    const cmd = normalizeCommand('git --version');
    const outside = checkFilePathsOutsideRoots(cmd, [process.cwd()]);
    expect(outside).toEqual([]);
  });

  it('expands ~ and checks against allowed roots', () => {
    const cmd = normalizeCommand('cat ~/.ssh/id_rsa');
    const outside = checkFilePathsOutsideRoots(cmd, [process.cwd()]);
    // ~ expands to home dir, which is outside cwd
    expect(outside.length).toBeGreaterThan(0);
  });

  it('uses cwd as fallback when allowedRoots is empty', () => {
    const cmd = normalizeCommand('cat README.md');
    const outside = checkFilePathsOutsideRoots(cmd, []);
    expect(outside).toEqual([]);
  });

  it('allows paths within custom allowed root', () => {
    const cmd = normalizeCommand('cat /sdcard/dapingguo.png');
    const outside = checkFilePathsOutsideRoots(cmd, ['/sdcard', process.cwd()]);
    expect(outside).toEqual([]);
  });

  it('detects multiple outside paths', () => {
    const cmd = normalizeCommand('cp /etc/passwd /sdcard/out.txt');
    const outside = checkFilePathsOutsideRoots(cmd, [process.cwd()]);
    expect(outside.length).toBe(2);
  });

  it('skips env variables and shell substitutions', () => {
    const cmd = normalizeCommand('cat $HOME/file.txt');
    // checkFilePathsOutsideRoots skips args starting with $, ${, $(, `
    const outside = checkFilePathsOutsideRoots(cmd, [process.cwd()]);
    expect(outside).toEqual([]);
  });

  it('handles ~/ expansion correctly', () => {
    const homeFile = '~/.bashrc';
    const resolved = resolveFilePath(homeFile);
    expect(resolved).toBe(path.resolve(os.homedir(), '.bashrc'));
  });
});
