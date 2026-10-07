/**
 * Ledger tests: JSONL append under data/judge-ledger/<yyyy-mm>/<session>.jsonl
 * (test temp dir), ring buffer semantics (last 200 for the status API), and
 * write failures must never throw.
 */

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JudgeLedger, type LedgerRecord } from '../../src/judge/ledger.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'judge-ledger-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function record(overrides: Partial<LedgerRecord> = {}): LedgerRecord {
  return {
    ts: '2026-01-15T10:00:00.000Z',
    sessionId: 'sess-1',
    pointId: 'tool.admission',
    decisionId: 'tool.admission@v1',
    mode: 'shadow',
    judgeId: 'opencode/jev-1.13',
    source: 'judge',
    answers: {},
    latencyMs: 42,
    ...overrides,
  };
}

describe('JudgeLedger — JSONL append', () => {
  it('writes under <yyyy-mm>/<session-id>.jsonl with one JSON object per line', () => {
    const yearMonth = new Date().toISOString().slice(0, 7);
    const dir = new JudgeLedger({ dir: tmpDir });
    dir.record(record());
    dir.record(record({ pointId: 'memory.worth', sessionId: 'sess-1' }));

    const monthDir = readdirSync(tmpDir);
    expect(monthDir).toEqual([yearMonth]);
    const sessionFile = join(tmpDir, yearMonth, 'sess-1.jsonl');
    expect(statSync(sessionFile).isFile()).toBe(true);

    const lines = readFileSync(sessionFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]) as LedgerRecord;
    expect(first).toMatchObject({
      ts: '2026-01-15T10:00:00.000Z',
      sessionId: 'sess-1',
      pointId: 'tool.admission',
      decisionId: 'tool.admission@v1',
      mode: 'shadow',
      judgeId: 'opencode/jev-1.13',
      source: 'judge',
      latencyMs: 42,
    });
    expect(JSON.parse(lines[1])).toMatchObject({ pointId: 'memory.worth' });
  });

  it('sanitizes hostile sessionId segments into one safe file name', () => {
    const dir = new JudgeLedger({ dir: tmpDir });
    dir.record(record({ sessionId: 'a/b:c\\d e' }));
    const [month] = readdirSync(tmpDir);
    const files = readdirSync(join(tmpDir, month));
    expect(files).toHaveLength(1);
    expect(files[0]).not.toMatch(/[/\\:]/);
  });
});

describe('JudgeLedger — ring buffer', () => {
  it('keeps the last 200 records by default', () => {
    const dir = new JudgeLedger({ dir: tmpDir });
    for (let i = 0; i < 250; i++) {
      dir.record(record({ pointId: `p${i}` }));
    }
    expect(dir.recent(300)).toHaveLength(200);
    const last20 = dir.recent(20);
    expect(last20).toHaveLength(20);
    expect(last20[0].pointId).toBe('p230');
    expect(last20[19].pointId).toBe('p249');
    // oldest-first ordering
    expect(last20.map((r) => r.pointId)).toEqual([
      ...Array.from({ length: 20 }, (_, i) => `p${230 + i}`),
    ]);
  });

  it('recent(n) with fewer records returns all of them oldest-first', () => {
    const dir = new JudgeLedger({ dir: tmpDir });
    dir.record(record({ pointId: 'p1' }));
    dir.record(record({ pointId: 'p2' }));
    expect(dir.recent(5).map((r) => r.pointId)).toEqual(['p1', 'p2']);
    expect(dir.recent(0)).toEqual([]);
  });
});

describe('JudgeLedger — failures', () => {
  it('a write failure never throws (dir path occupied by a file)', () => {
    const blocked = join(tmpDir, 'blocked');
    mkdirSync(join(tmpDir), { recursive: true });
    writeFileSync(blocked, 'not a dir', 'utf8');
    const dir = new JudgeLedger({ dir: blocked });
    expect(() => dir.record(record())).not.toThrow();
    // Ring buffer still received the record for the status API.
    expect(dir.recent(1)).toHaveLength(1);
  });

  it('a corrupt ledger line is skipped by query()', () => {
    const dir = new JudgeLedger({ dir: tmpDir });
    dir.record(record({ sessionId: 's1', ts: '2026-01-15T10:00:00.000Z' }));
    const [month] = readdirSync(tmpDir);
    const file = join(tmpDir, month, 's1.jsonl');
    const current = readFileSync(file, 'utf8');
    writeFileSync(file, `${current}not-json\n`, 'utf8');
    const result = dir.query({});
    expect(result.total).toBe(1);
    expect(result.entries[0]?.pointId).toBe('tool.admission');
  });
});

describe('JudgeLedger — query (GET /api/judge/ledger contract)', () => {
  const TS_A = '2026-01-15T10:00:00.000Z';
  const TS_B = '2026-01-15T12:00:00.000Z';
  const TS_C = '2026-01-16T12:00:00.000Z';

  function store(): JudgeLedger {
    const dir = new JudgeLedger({ dir: tmpDir });
    dir.record(record({ ts: TS_C, sessionId: 'sess-2', mode: 'active' }));
    dir.record(record({ ts: TS_B, sessionId: 'sess-2', mode: 'shadow' }));
    dir.record(
      record({ ts: TS_A, sessionId: 'sess-1', source: 'fallback', fallbackReason: 'no-key' }),
    );
    return dir;
  }

  it('absolute contract: all records, newest first, 1-based paging', () => {
    const result = store().query({});
    expect(result.total).toBe(3);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
    expect(result.entries.map((e) => e.ts)).toEqual([TS_C, TS_B, TS_A]);
  });

  it('paging windows the newest first', () => {
    const dir = store();
    const p1 = dir.query({ page: 1, pageSize: 2 });
    expect(p1.total).toBe(3);
    expect(p1.entries.map((e) => e.ts)).toEqual([TS_C, TS_B]);
    const p2 = dir.query({ page: 2, pageSize: 2 });
    expect(p2.entries.map((e) => e.ts)).toEqual([TS_A]);
  });

  it('pointId / mode / outcome filters', () => {
    const dir = store();
    expect(dir.query({ pointId: 'tool.admission' }).total).toBe(3);
    expect(dir.query({ pointId: 'memory.worth' }).total).toBe(0);
    expect(dir.query({ mode: 'shadow' }).total).toBe(2);
    expect(dir.query({ mode: 'active' }).total).toBe(1);
    expect(dir.query({ outcome: 'judge' }).total).toBe(2);
    // 'judged' is an accepted alias for 'judge'.
    expect(dir.query({ outcome: 'judged' }).total).toBe(2);
    expect(dir.query({ outcome: 'fallback' }).total).toBe(1);
    // Unknown outcome values answer empty — never everything.
    expect(dir.query({ outcome: 'weird' }).total).toBe(0);
  });

  it('from/to accept ISO strings AND epoch-millis digit strings', () => {
    const dir = store();
    expect(dir.query({ from: TS_B }).total).toBe(2);
    expect(dir.query({ from: '2026-01-15' }).total).toBe(3);
    expect(dir.query({ from: '2026-01-16' }).total).toBe(1);
    // Bare digit form (the parseEpochMs path).
    expect(dir.query({ from: String(Date.parse(TS_B)) }).total).toBe(2);
    expect(dir.query({ to: String(Date.parse(TS_A)) }).total).toBe(1);
  });

  it('session filter reads only that session file across months', () => {
    const dir = store();
    expect(dir.query({ session: 'sess-1' }).total).toBe(1);
    expect(dir.query({ session: 'sess-2' }).total).toBe(2);
    // Session files are sanitized — hostile names still hit.
    expect(store().query({ session: 'a/b:c\\d e' }).total).toBe(0);
  });

  it('query finds records in earlier months (month dirs sorted desc)', () => {
    const ledger = new JudgeLedger({
      dir: tmpDir,
      now: () => new Date('2025-12-05T10:00:00Z').getTime(),
    });
    ledger.record(record({ ts: '2025-12-05T10:00:00.000Z', sessionId: 'old-1' }));
    const current = store();
    expect(current.query({ session: 'old-1' }).total).toBe(1);
  });

  it('missing directory answers empty', () => {
    const dir = new JudgeLedger({ dir: join(tmpDir, 'definitely-missing') });
    expect(dir.query({})).toEqual({ entries: [], total: 0, page: 1, pageSize: 20 });
  });
});
