/**
 * Judge autopilot runtime wiring (src/app/judge-autopilot.ts): one audit pass
 * promotes a gate-passing point by writing config.yaml `judge.modes` + the
 * managed state file, and a later degraded audit demotes it back — fully
 * automatic, no human confirmation. The write always goes through
 * mutateConfigYaml(), so CONFIG_FILE is pinned to a temp copy.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../src/app/types.js';
import { auditOnce } from '../../src/app/judge-autopilot.js';
import { emptyStats } from '../../src/judge/autopilot.js';

const REAL = 'a1b2c3d4-1111-4222-8333-444455556666';

let root = '';
let configPath = '';
let ledgerDir = '';
let cleanup: (() => void) | undefined;
let onConfigSaved: ReturnType<typeof vi.fn>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'judge-autopilot-run-'));
  configPath = join(root, 'config.yaml');
  ledgerDir = join(root, 'judge-ledger');
  // Minimal judge section: enabled, everything defaults to shadow via
  // modes.default, one primary judge configured (schema-valid shape).
  writeFileSync(
    configPath,
    [
      'judge:',
      '  enabled: true',
      '  provider: mock',
      '  model_ref: mock-1',
      '  modes:',
      '    default: shadow',
      '  features:',
      '    test_log_fold: "off"',
      '',
    ].join('\n'),
  );
  process.env.CONFIG_FILE = configPath;
  onConfigSaved = vi.fn();
  cleanup = () => {
    delete process.env.CONFIG_FILE;
    rmSync(root, { recursive: true, force: true });
  };
});

afterEach(() => cleanup?.());

const appConfig = () =>
  ({
    judge: parse(readFileSync(configPath, 'utf8')).judge,
  }) as unknown as AppConfig;

function seedLedger(entries: Array<Record<string, unknown>>): void {
  const month = '2026-02';
  mkdirSync(join(ledgerDir, month), { recursive: true });
  writeFileSync(
    join(ledgerDir, month, `${REAL}.jsonl`),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
}

function judgedEntry(
  pointId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    pointId,
    sessionId: REAL,
    mode: 'shadow',
    source: 'judge',
    answers: {},
    latencyMs: 900,
    agree: true,
    ...extra,
  };
}

describe('auditOnce', () => {
  it('promotes a gate-passing shadow point: config.yaml modes + managed state + hot reload', async () => {
    seedLedger(Array.from({ length: 30 }, () => judgedEntry('memory.capture')));
    const report = await auditOnce({
      ledgerDir,
      judge: appConfig().judge,
      getConfig: appConfig,
      onConfigSaved: onConfigSaved as never,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });
    expect(report.promote).toContain('memory.capture');
    const yaml = parse(readFileSync(configPath, 'utf8')) as {
      judge?: { modes?: Record<string, string> };
    };
    expect(yaml.judge?.modes?.['memory.capture']).toBe('active');
    expect(onConfigSaved).toHaveBeenCalledTimes(yaml.judge?.modes ? 1 : 0);
    // Managed state persisted for future demotion eligibility.
    const managedReport = report.managed['memory.capture'];
    expect(managedReport?.promotedAt).toBeTruthy();
  });

  it('demotes a managed active point whose window degraded, back to shadow', async () => {
    // Promote first (30 healthy entries).
    seedLedger(Array.from({ length: 30 }, () => judgedEntry('memory.capture')));
    await auditOnce({
      ledgerDir,
      judge: appConfig().judge,
      getConfig: appConfig,
      onConfigSaved: onConfigSaved as never,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });
    // Degrade the recent window with service failures.
    const file = join(ledgerDir, '2026-02', `${REAL}.jsonl`);
    appendFileSync(
      file,
      Array.from({ length: 12 }, () =>
        JSON.stringify(
          judgedEntry('memory.capture', { source: 'fallback', fallbackReason: 'unavailable' }),
        ),
      ).join('\n') + '\n',
    );
    const report = await auditOnce({
      ledgerDir,
      judge: appConfig().judge,
      getConfig: appConfig,
      onConfigSaved: onConfigSaved as never,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });
    expect(report.demote).toContain('memory.capture');
    const yaml = parse(readFileSync(configPath, 'utf8')) as {
      judge?: { modes?: Record<string, string> };
    };
    expect(yaml.judge?.modes?.['memory.capture']).toBe('shadow');
  });

  it('leaves user-pinned points alone and holds on insufficient samples', async () => {
    writeFileSync(
      configPath,
      [
        'judge:',
        '  enabled: true',
        '  provider: mock',
        '  model_ref: mock-1',
        '  modes:',
        '    default: shadow',
        '    channel.triage: active',
        '  features:',
        '    test_log_fold: "off"',
        '',
      ].join('\n'),
    );
    seedLedger(Array.from({ length: 2 }, () => judgedEntry('channel.triage')));
    const report = await auditOnce({
      ledgerDir,
      judge: appConfig().judge,
      getConfig: appConfig,
      onConfigSaved: onConfigSaved as never,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });
    expect(report.promote).toEqual([]);
    expect(report.demote).toEqual([]); // unmanaged active point: untouched
  });

  it('counts nothing when no ledger exists', async () => {
    const report = await auditOnce({
      ledgerDir,
      judge: appConfig().judge,
      getConfig: appConfig,
      onConfigSaved: onConfigSaved as never,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });
    expect(report.promote).toEqual([]);
    expect(report.report.length).toBeGreaterThan(0); // report shell still built
    void emptyStats;
  });
});
