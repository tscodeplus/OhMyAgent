/**
 * Tests for yaml-mutation.ts
 *
 * The serialised read-modify-write helper that all config.yaml writers share.
 * Covers the lost-update race it exists to fix, comment preservation, atomic
 * writes, re-entrancy detection and error propagation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  applyConfigObject,
  mutateConfigYaml,
  readConfigObject,
} from '../../src/app/webui/yaml-mutation.js';

let dir: string;
let configPath: string;
let previousConfigFile: string | undefined;

function readConfig(): Record<string, unknown> {
  return (parseYaml(readFileSync(configPath, 'utf-8')) ?? {}) as Record<string, unknown>;
}

function writeConfig(text: string): void {
  writeFileSync(configPath, text, 'utf-8');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oma-yaml-mutation-'));
  configPath = join(dir, 'config.yaml');
  previousConfigFile = process.env.CONFIG_FILE;
  process.env.CONFIG_FILE = configPath;
});

afterEach(() => {
  if (previousConfigFile === undefined) {
    delete process.env.CONFIG_FILE;
  } else {
    process.env.CONFIG_FILE = previousConfigFile;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('mutateConfigYaml', () => {
  it('applies the mutation and preserves comments on untouched sections', async () => {
    writeConfig(
      [
        '# OhMyAgent config',
        'provider:',
        '  primary: openai/gpt-4 # keep this',
        'log_level: info',
        '',
      ].join('\n'),
    );

    await mutateConfigYaml((doc) => {
      const next = readConfigObject(doc);
      next.log_level = 'debug';
      applyConfigObject(doc, next);
    });

    const text = readFileSync(configPath, 'utf-8');
    expect(text).toContain('# OhMyAgent config');
    expect(text).toContain('# keep this');
    expect(readConfig()).toEqual({
      provider: { primary: 'openai/gpt-4' },
      log_level: 'debug',
    });
  });

  it('serialises concurrent mutations so neither update is lost', async () => {
    writeConfig('existing: true\n');
    const order: string[] = [];

    // First operation awaits mid-flight — the shape of an MCP install that
    // tests a connection between read and write.
    const first = mutateConfigYaml(async (doc) => {
      const next = readConfigObject(doc);
      order.push('first:read');
      await delay(25);
      next.mcp = { enabled: true };
      applyConfigObject(doc, next);
      order.push('first:written');
    });

    const second = mutateConfigYaml((doc) => {
      const next = readConfigObject(doc);
      order.push('second:read');
      next.agents = { reviewer: { name: 'Reviewer' } };
      applyConfigObject(doc, next);
    });

    await Promise.all([first, second]);

    // Strict FIFO: the second operation only starts after the first finished,
    // so it observes the first operation's write.
    expect(order).toEqual(['first:read', 'first:written', 'second:read']);
    expect(readConfig()).toEqual({
      existing: true,
      mcp: { enabled: true },
      agents: { reviewer: { name: 'Reviewer' } },
    });
  });

  it('creates config.yaml when it does not exist yet', async () => {
    expect(() => readConfig()).toThrow();

    await mutateConfigYaml((doc) => {
      const next = readConfigObject(doc);
      next.log_level = 'warn';
      applyConfigObject(doc, next);
    });

    expect(readConfig()).toEqual({ log_level: 'warn' });
  });

  it('leaves the file untouched when the mutator throws', async () => {
    writeConfig('log_level: info\n');

    await expect(
      mutateConfigYaml(() => {
        throw new Error('mutator failed');
      }),
    ).rejects.toThrow('mutator failed');

    expect(readConfig()).toEqual({ log_level: 'info' });
  });

  it('keeps serving later mutations after one fails', async () => {
    writeConfig('log_level: info\n');

    const failing = mutateConfigYaml(() => {
      throw new Error('mutator failed');
    });
    const succeeding = mutateConfigYaml((doc) => {
      const next = readConfigObject(doc);
      next.log_level = 'debug';
      applyConfigObject(doc, next);
    });

    await expect(failing).rejects.toThrow('mutator failed');
    await expect(succeeding).resolves.toBeUndefined();
    expect(readConfig()).toEqual({ log_level: 'debug' });
  });

  it('rejects a re-entrant call instead of deadlocking', async () => {
    writeConfig('log_level: info\n');

    await expect(
      mutateConfigYaml(async () => {
        await mutateConfigYaml(() => {
          throw new Error('nested mutation must never run');
        });
      }),
    ).rejects.toThrow(/re-entrant/);

    expect(readConfig()).toEqual({ log_level: 'info' });
  });

  it('rejects on malformed YAML and does not overwrite the file', async () => {
    const malformed = 'provider: [1, 2\n';
    writeConfig(malformed);

    await expect(
      mutateConfigYaml((doc) => {
        const next = readConfigObject(doc);
        next.log_level = 'debug';
        applyConfigObject(doc, next);
      }),
    ).rejects.toThrow(/Failed to parse config file/);

    expect(readFileSync(configPath, 'utf-8')).toBe(malformed);
  });

  it('writes through a temp file and leaves no leftovers behind', async () => {
    writeConfig('log_level: info\n');

    await mutateConfigYaml((doc) => {
      const next = readConfigObject(doc);
      next.log_level = 'debug';
      applyConfigObject(doc, next);
    });

    expect(readdirSync(dir)).toEqual(['config.yaml']);
  });

  it('removes keys absent from the applied object, including undefined values', async () => {
    writeConfig('keep: 1\ndrop: 2\nblank:\n');

    await mutateConfigYaml((doc) => {
      const next = readConfigObject(doc);
      delete next.drop;
      next.blank = undefined;
      next.added = 'yes';
      applyConfigObject(doc, next);
    });

    expect(readConfig()).toEqual({ keep: 1, added: 'yes' });
  });

  it('does not rewrite keys whose value is unchanged', async () => {
    writeConfig('tuned: 8\n');

    await mutateConfigYaml((doc) => {
      const next = readConfigObject(doc);
      // Same value, different quoted style — the scalar node must survive.
      next.tuned = 8;
      applyConfigObject(doc, next);
    });

    expect(readFileSync(configPath, 'utf-8')).toBe('tuned: 8\n');
  });
});
