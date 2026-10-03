/**
 * Tests for config-persist.ts
 *
 * The agents writer must route through the shared serialised helper, so a save
 * that races with another config.yaml writer (an MCP install, the settings
 * form) cannot drop either side's fields.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const mockLoadConfig = vi.fn();

vi.mock('../../src/app/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/app/config.js')>();
  return { ...actual, loadConfig: () => mockLoadConfig(), resetConfig: vi.fn() };
});

import { createOnConfigChanged } from '../../src/app/webui/config-persist.js';
import {
  applyConfigObject,
  mutateConfigYaml,
  readConfigObject,
} from '../../src/app/webui/yaml-mutation.js';

let dir: string;
let configPath: string;
let previousConfigFile: string | undefined;
let logger: { error: ReturnType<typeof vi.fn> };

function readConfig(): Record<string, unknown> {
  return (parseYaml(readFileSync(configPath, 'utf-8')) ?? {}) as Record<string, unknown>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oma-config-persist-'));
  configPath = join(dir, 'config.yaml');
  previousConfigFile = process.env.CONFIG_FILE;
  process.env.CONFIG_FILE = configPath;
  logger = { error: vi.fn() };
  mockLoadConfig.mockReset();
});

afterEach(() => {
  if (previousConfigFile === undefined) {
    delete process.env.CONFIG_FILE;
  } else {
    process.env.CONFIG_FILE = previousConfigFile;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('createOnConfigChanged', () => {
  it('persists agents as a YAML map and keeps existing comments', async () => {
    writeFileSync(
      configPath,
      [
        '# OhMyAgent config',
        'log_level: info',
        'agents:',
        '  old: # replaced',
        '    name: Old',
        '',
      ].join('\n'),
      'utf-8',
    );
    mockLoadConfig.mockReturnValue({
      agents: [
        { id: 'reviewer', name: 'Reviewer', model: 'gpt-4' },
        { id: 'writer', name: 'Writer' },
      ],
    });

    createOnConfigChanged(logger)();

    await vi.waitFor(() => {
      expect(readConfig().agents).toEqual({
        reviewer: { name: 'Reviewer', model: 'gpt-4' },
        writer: { name: 'Writer' },
      });
    });
    expect(readFileSync(configPath, 'utf-8')).toContain('# OhMyAgent config');
    expect(readConfig().log_level).toBe('info');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('drops the agents section when no agents are configured', async () => {
    writeFileSync(configPath, 'log_level: info\nagents:\n  old:\n    name: Old\n', 'utf-8');
    mockLoadConfig.mockReturnValue({ agents: [] });

    createOnConfigChanged(logger)();

    await vi.waitFor(() => {
      expect(Object.keys(readConfig())).toEqual(['log_level']);
    });
  });

  it('does not create config.yaml when it is missing', async () => {
    mockLoadConfig.mockReturnValue({ agents: [{ id: 'reviewer', name: 'Reviewer' }] });

    createOnConfigChanged(logger)();

    // The callback returns before the queued write would run; give it room to
    // run so a missing-file regression cannot pass by accident.
    await delay(20);
    expect(existsSync(configPath)).toBe(false);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('surfaces write failures through the logger', async () => {
    writeFileSync(configPath, 'provider: [1, 2\n', 'utf-8');
    mockLoadConfig.mockReturnValue({ agents: [{ id: 'reviewer', name: 'Reviewer' }] });

    createOnConfigChanged(logger)();

    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith(
        '[onConfigChanged] Failed to persist config:',
        expect.any(Error),
      );
    });
  });

  it('does not lose an agents save that races with another config writer', async () => {
    writeFileSync(configPath, 'log_level: info\n', 'utf-8');
    mockLoadConfig.mockReturnValue({ agents: [{ id: 'reviewer', name: 'Reviewer' }] });

    // Another writer (an MCP install) is already mid-flight and awaits before
    // writing — the exact interleaving that previously lost one side's fields.
    const install = mutateConfigYaml(async (doc) => {
      const next = readConfigObject(doc);
      await delay(25);
      next.mcp = { enabled: true, servers: {} };
      applyConfigObject(doc, next);
    });

    createOnConfigChanged(logger)();
    await install;

    await vi.waitFor(() => {
      expect(readConfig().agents).toEqual({ reviewer: { name: 'Reviewer' } });
    });
    expect(readConfig().mcp).toEqual({ enabled: true, servers: {} });
    expect(readConfig().log_level).toBe('info');
    expect(logger.error).not.toHaveBeenCalled();
  });
});
