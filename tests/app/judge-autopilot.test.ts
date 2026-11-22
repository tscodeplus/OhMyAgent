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

/**
 * 45 healthy shadow entries: one divergence (required evidence) and 44
 * agreements, which still clears the 90% Wilson lower bound.
 */
function healthyHistory(pointId: string, n = 45): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => judgedEntry(pointId, i === 0 ? { agree: false } : {}));
}

describe('auditOnce', () => {
  it('promotes a gate-passing shadow point: config.yaml modes + managed state + hot reload', async () => {
    seedLedger(healthyHistory('memory.capture'));
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
    // Promote first (healthy shadow history).
    seedLedger(healthyHistory('memory.capture'));
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

  it('records the last audit even when every point holds', async () => {
    seedLedger(Array.from({ length: 2 }, () => judgedEntry('memory.capture')));
    const report = await auditOnce({
      ledgerDir,
      judge: appConfig().judge,
      getConfig: appConfig,
      onConfigSaved: onConfigSaved as never,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });
    expect(report.promote).toEqual([]);
    expect(report.lastRun?.ranAt).toBeTruthy();
    // Persisted, so a later dry-run (the WebUI panel) can report it.
    const state = JSON.parse(readFileSync(join(ledgerDir, 'autopilot.json'), 'utf8')) as {
      managed: Record<string, unknown>;
      lastRun?: { ranAt: string; promote: string[] };
    };
    expect(state.lastRun?.ranAt).toBe(report.lastRun?.ranAt);
    expect(state.lastRun?.promote).toEqual([]);
    expect(state.managed).toEqual({});
  });

  it('ignores history from a judge the current chain no longer uses', async () => {
    // The chain is what the WebUI writes (and what the resolver names judges
    // after): entries from any other judge must not vouch for it.
    writeFileSync(
      configPath,
      [
        'judge:',
        '  enabled: true',
        '  chain:',
        '    - mock/mock-1',
        '  modes:',
        '    default: shadow',
        '    memory.capture: shadow',
        '  features:',
        '    test_log_fold: "off"',
        '',
      ].join('\n'),
    );
    // 30 perfect samples, but all from a retired judge → they cannot vouch for
    // the configured mock/mock-1 chain, so the point must hold at 0 samples.
    seedLedger(
      healthyHistory('memory.capture').map((e) => ({
        ...e,
        judgeId: 'retired/m0',
        ts: new Date().toISOString(),
      })),
    );
    const report = await auditOnce({
      ledgerDir,
      judge: appConfig().judge,
      getConfig: appConfig,
      onConfigSaved: onConfigSaved as never,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });
    expect(report.promote).toEqual([]);
    const point = report.report.find((r) => r.pointId === 'memory.capture')!;
    expect(point.stats.total).toBe(0);
    expect(point.reasons.map((r) => r.code)).toContain('samples');
    expect(point.reasons.map((r) => r.message).join(' | ')).toContain('samples 0 < 30');
  });

  it('persists the managed map and lastRun BEFORE the hot reload fires', async () => {
    seedLedger(healthyHistory('memory.capture'));
    // Once config.yaml says "active", the managed map that earns a future
    // demotion must already be on disk — so the hook below asserts it exists at
    // the moment the reload is announced.
    let stateAtReload: { managed?: Record<string, unknown>; lastRun?: { promote?: string[] } } = {};
    const onConfigSavedAtReload = vi.fn(() => {
      stateAtReload = JSON.parse(readFileSync(join(ledgerDir, 'autopilot.json'), 'utf8'));
    });
    const report = await auditOnce({
      ledgerDir,
      judge: appConfig().judge,
      getConfig: appConfig,
      onConfigSaved: onConfigSavedAtReload as never,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });
    expect(report.promote).toContain('memory.capture');
    expect(stateAtReload.managed?.['memory.capture']).toBeTruthy();
    expect(stateAtReload.lastRun?.promote).toEqual(['memory.capture']);
  });

  it('records a failed audit instead of failing silently', async () => {
    seedLedger(healthyHistory('memory.capture'));
    const deps = {
      ledgerDir,
      judge: appConfig().judge,
      getConfig: appConfig,
      onConfigSaved: onConfigSaved as never,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    };
    const { recordAuditFailure } = await import('../../src/app/judge-autopilot.js');
    recordAuditFailure(deps, new Error('config.yaml is read-only'));
    const state = JSON.parse(readFileSync(join(ledgerDir, 'autopilot.json'), 'utf8')) as {
      lastRun?: { error?: string };
    };
    expect(state.lastRun?.error).toContain('read-only');
  });
});
