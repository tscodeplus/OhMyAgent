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
});
