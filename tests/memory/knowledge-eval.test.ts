/**
 * K0 baseline measurement harness (plan §6 K0): the pure metric functions, the
 * JSONL loader's honesty rules, and an end-to-end run against the real
 * `tests/eval/knowledge/*.jsonl` datasets with stub retrievers.
 *
 * Placed under tests/memory/ (not tests/knowledge/) because the code under test
 * lives in src/memory/eval/ — same directory as eval-runner.test.ts.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  KNOWLEDGE_EVAL_DATASET_DIR,
  PERSONA_FRESHNESS_TOLERANCE_MS,
  computeInactiveLeakageCount,
  computeKeywordRecallAt5,
  computeLatencyPercentiles,
  computePersonaFreshness,
  findLatestBaseline,
  formatBaselineDiff,
  formatKnowledgeEvalReport,
  loadBaseline,
  loadKnowledgeEvalDataset,
  runKnowledgeEval,
  writeBaseline,
} from '../../src/memory/eval/knowledge-eval.js';
import type {
  KnowledgeEvalDataset,
  KnowledgeEvalRun,
  RetrievalHit,
} from '../../src/memory/eval/knowledge-eval.js';

function makeTempDatasetDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-eval-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf-8');
  }
  return dir;
}

describe('computeKeywordRecallAt5', () => {
  it('is a hit only when every keyword appears in the injected text', () => {
    const text = '用户指定工作目录为 D:\\tmp\\excel-mcp，源目录为 E:\\Excel。';
    expect(computeKeywordRecallAt5(text, ['D:\\tmp\\excel-mcp', 'E:\\Excel'])).toBe(true);
    expect(computeKeywordRecallAt5(text, ['D:\\tmp\\excel-mcp', 'Power Query'])).toBe(false);
  });

  it('normalises case, full-width characters and whitespace', () => {
    expect(computeKeywordRecallAt5('ＥＸＣＥＬ－ＭＣＰ 可用', ['excel-mcp'])).toBe(true);
    expect(computeKeywordRecallAt5('Sheet\n数：3', ['sheet 数'])).toBe(true);
    expect(computeKeywordRecallAt5('用户偏好\u3000简洁', ['用户偏好 简洁'])).toBe(true);
  });

  it('treats an empty keyword list as no hit, not as a free pass', () => {
    expect(computeKeywordRecallAt5('anything at all', [])).toBe(false);
  });
});

describe('computeLatencyPercentiles', () => {
  it('returns zeros for an empty sample', () => {
    expect(computeLatencyPercentiles([])).toEqual({ avg: 0, p50: 0, p95: 0 });
  });

  it('uses nearest-rank percentiles on the sorted samples', () => {
    // 4 samples: nearest rank for 50% is index 1, for 95% it is index 3.
    expect(computeLatencyPercentiles([10, 20, 30, 40])).toEqual({ avg: 25, p50: 20, p95: 40 });
    // Order of arrival must not matter.
    expect(computeLatencyPercentiles([40, 10, 30, 20])).toEqual({ avg: 25, p50: 20, p95: 40 });
  });

  it('collapses to the single value with one sample', () => {
    expect(computeLatencyPercentiles([7])).toEqual({ avg: 7, p50: 7, p95: 7 });
  });

  it('reports p95 at or above p50 for skewed samples', () => {
    const result = computeLatencyPercentiles([5, 6, 7, 8, 500]);
    expect(result.p95).toBe(500);
    expect(result.p50).toBeLessThanOrEqual(result.p95);
    expect(result.avg).toBeCloseTo(105.2, 5);
  });
});

describe('computePersonaFreshness', () => {
  const persona = 1_791_416_603_000;

  it('is unknown when either timestamp is missing or unparseable', () => {
    expect(computePersonaFreshness(null, persona)).toBe('unknown');
    expect(computePersonaFreshness(persona, null)).toBe('unknown');
    expect(computePersonaFreshness(undefined, undefined)).toBe('unknown');
    // parseEpochMs() returns 0 for a TEXT value it cannot interpret.
    expect(computePersonaFreshness(0, persona)).toBe('unknown');
    expect(computePersonaFreshness(Number.NaN, persona)).toBe('unknown');
  });

  it('is fresh when the persona is at least as new as the newest preference', () => {
    expect(computePersonaFreshness(persona, persona - 8_000)).toBe('fresh');
    expect(computePersonaFreshness(persona, persona)).toBe('fresh');
  });

  it('tolerates a preference written within the distillation window', () => {
    expect(computePersonaFreshness(persona, persona + PERSONA_FRESHNESS_TOLERANCE_MS)).toBe(
      'fresh',
    );
  });

  it('is stale when the memory layer moved on past the tolerance', () => {
    expect(computePersonaFreshness(persona, persona + PERSONA_FRESHNESS_TOLERANCE_MS + 1)).toBe(
      'stale',
    );
  });
});

describe('computeInactiveLeakageCount', () => {
  const statuses: Record<string, string> = {
    'mem-active': 'active',
    'mem-superseded': 'superseded',
    'mem-invalidated': 'invalidated',
  };

  it('counts only ids whose status is a known non-active value', () => {
    expect(
      computeInactiveLeakageCount(
        ['mem-active', 'mem-superseded', 'mem-invalidated', 'msg-unknown'],
        (id) => statuses[id] ?? null,
      ),
    ).toBe(2);
  });

  it('counts a duplicated injected id once', () => {
    expect(
      computeInactiveLeakageCount(['mem-superseded', 'mem-superseded'], (id) => statuses[id]),
    ).toBe(1);
  });

  it('is zero when everything injected is active', () => {
    expect(computeInactiveLeakageCount(['mem-active'], (id) => statuses[id])).toBe(0);
  });
});

describe('loadKnowledgeEvalDataset', () => {
  it('loads the shipped datasets with the sizes the plan specifies', () => {
    const dataset = loadKnowledgeEvalDataset(KNOWLEDGE_EVAL_DATASET_DIR);
    expect(dataset.episodic).toHaveLength(10);
    expect(dataset.semantic).toHaveLength(15);
    expect(dataset.preference).toHaveLength(20);
  });

  it('scores only labelled cases and explains every unlabelled one', () => {
    const dataset = loadKnowledgeEvalDataset(KNOWLEDGE_EVAL_DATASET_DIR);
    const all = [...dataset.episodic, ...dataset.semantic, ...dataset.preference];
    const unlabelled = all.filter((c) => c.unlabelled);
    expect(unlabelled.length).toBeGreaterThan(0);
    for (const evalCase of unlabelled) {
      // An unlabelled case without a reason is a silent exclusion.
      expect((evalCase.note ?? '').length).toBeGreaterThan(0);
    }
    // The loader rejects a labelled case with no golden, so reaching here means
    // every labelled case carries one.
    for (const evalCase of dataset.episodic.filter((c) => !c.unlabelled)) {
      expect(evalCase.expectedMessageIds.length).toBeGreaterThan(0);
    }
  });

  it('keeps 5 changed-preference cases, one of which is unlabelled on purpose', () => {
    const { preference } = loadKnowledgeEvalDataset(KNOWLEDGE_EVAL_DATASET_DIR);
    const changed = preference.filter((c) => c.mustNotContain.length > 0 || c.unlabelled);
    expect(changed).toHaveLength(5);
    // 4 measurable, 1 excluded because old and new text are indistinguishable.
    expect(changed.filter((c) => c.mustNotContain.length > 0)).toHaveLength(4);
    expect(changed.filter((c) => c.unlabelled)).toHaveLength(1);
  });

  it('rejects malformed JSONL with the file and line number', () => {
    const dir = makeTempDatasetDir({
      'episodic.jsonl': '{"id":"e1","query":"q","expectedMessageIds":["m1"]}\nnot json\n',
      'semantic.jsonl': '',
      'preference.jsonl': '',
    });
    expect(() => loadKnowledgeEvalDataset(dir)).toThrow(/episodic\.jsonl:2: invalid JSON/);
  });

  it('rejects duplicate case ids', () => {
    const dir = makeTempDatasetDir({
      'episodic.jsonl':
        '{"id":"e1","query":"q1","expectedMessageIds":["m1"]}\n{"id":"e1","query":"q2","expectedMessageIds":["m2"]}\n',
      'semantic.jsonl': '',
      'preference.jsonl': '',
    });
    expect(() => loadKnowledgeEvalDataset(dir)).toThrow(/duplicate case id "e1"/);
  });

  it('rejects a labelled case with no golden', () => {
    const dir = makeTempDatasetDir({
      'episodic.jsonl': '',
      'semantic.jsonl': '{"id":"s1","query":"q","expectedKeywords":[]}\n',
      'preference.jsonl': '',
    });
    expect(() => loadKnowledgeEvalDataset(dir)).toThrow(
      /labelled case "s1" needs expectedKeywords or expectedMemoryIds/,
    );
  });
});

/** Stub memory lane that answers every case from its own golden. */
function stubMemoryLane(
  dataset: KnowledgeEvalDataset,
  delayMs = 0,
): {
  retrieve: (query: string, topK: number) => Promise<RetrievalHit[]>;
  queried: string[];
} {
  const byQuery = new Map<string, RetrievalHit[]>();
  for (const evalCase of dataset.semantic) {
    byQuery.set(
      evalCase.query,
      (evalCase.expectedMemoryIds ?? []).map((id) => ({
        id,
        text: evalCase.expectedKeywords.join(' '),
      })),
    );
  }
  for (const evalCase of dataset.preference) {
    byQuery.set(
      evalCase.query,
      evalCase.mustContain.length > 0
        ? [{ id: `mem-for-${evalCase.id}`, text: evalCase.mustContain.join(' ') }]
        : [],
    );
  }
  const queried: string[] = [];
  return {
    queried,
    retrieve: async (query: string) => {
      queried.push(query);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return byQuery.get(query) ?? [];
    },
  };
}

describe('runKnowledgeEval', () => {
  it('reports the wired and unwired lanes and scores only what was wired', async () => {
    const dataset = loadKnowledgeEvalDataset(KNOWLEDGE_EVAL_DATASET_DIR);
    const lane = stubMemoryLane(dataset, 2);
    const run = await runKnowledgeEval({ retrieveMemories: lane.retrieve });

    expect(run.lanes).toEqual(['memories']);
    expect(run.unwiredLanes).toEqual(['messages', 'knowledge']);
    expect(run.topK).toBe(5);
    expect(run.statusLookupProvided).toBe(false);

    // Episodic questions are scored on the message lane, which is not wired at
    // K0 — that 0 is the baseline finding, not a skipped measurement.
    expect(run.episodic.labelled).toBe(9);
    expect(run.episodic.unlabelled).toBe(1);
    expect(run.episodic.unlabelledIds).toEqual(['ep-10']);
    expect(run.episodic.idRecallAt5).toBe(0);
    expect(run.episodic.mrr).toBe(0);

    // The memory lane answers the semantic goldens it was handed.
    expect(run.semantic.labelled).toBe(10);
    expect(run.semantic.unlabelled).toBe(5);
    expect(run.semantic.idRecallAt5).toBe(1);
    expect(run.semantic.keywordRecallAt5).toBe(1);
    expect(run.semantic.keywordCases).toBe(10);
    expect(run.semantic.missedCaseIds).toEqual([]);
    expect(run.semantic.mrr).toBe(1);

    // Aggregate = micro-average over the 19 id-labelled cases.
    expect(run.metrics.totalQueries).toBe(19);
    expect(run.metrics.queriesWithResults).toBe(10);
    expect(run.metrics.idRecallAt5).toBeCloseTo(10 / 19, 10);
    expect(run.metrics.mrr).toBeCloseTo(10 / 19, 10);

    // Preference: the stub returns each case's own mustContain text, so the
    // stale/contain mechanics are exercised without claiming a real result.
    expect(run.preference.labelled).toBe(19);
    expect(run.preference.unlabelled).toBe(1);
    expect(run.preference.staleCases).toBe(4);
    expect(run.preference.stalePreferenceRate).toBe(0);
    expect(run.preference.mustContainCases).toBe(19);
    expect(run.preference.mustContainRate).toBe(1);

    // Timing is measured per lane call, so the stub's delay shows up.
    expect(run.metrics.averageRetrievalLatencyMs).toBeGreaterThanOrEqual(1);
    expect(run.metrics.latencyP95Ms).toBeGreaterThanOrEqual(run.metrics.latencyP50Ms);
    expect(run.summary).toContain('lanes wired: memories');
    expect(formatKnowledgeEvalReport(run)).toContain('personaFreshness: unknown');
  });

  it('never queries an unlabelled case', async () => {
    const dataset = loadKnowledgeEvalDataset(KNOWLEDGE_EVAL_DATASET_DIR);
    const lane = stubMemoryLane(dataset);
    await runKnowledgeEval({ retrieveMemories: lane.retrieve });

    const unlabelledQueries = new Set(
      [...dataset.episodic, ...dataset.semantic, ...dataset.preference]
        .filter((c) => c.unlabelled)
        .map((c) => c.query),
    );
    expect(unlabelledQueries.size).toBe(7);
    for (const query of lane.queried) {
      expect(unlabelledQueries.has(query)).toBe(false);
    }
  });

  it('scores a superseded value leak as a stale preference', async () => {
    const dataset = loadKnowledgeEvalDataset(KNOWLEDGE_EVAL_DATASET_DIR);
    const changedCase = dataset.preference.find((c) => c.id === 'pref-17');
    if (!changedCase) throw new Error('pref-17 missing from the preference dataset');

    const run = await runKnowledgeEval({
      // Only pref-17's query gets the superseded row back — the failure mode
      // G1's stalePreferenceRate exists to catch.
      retrieveMemories: async (query) =>
        query === changedCase.query
          ? [{ id: 'rWqtT5zTH68NdtJadc_B-', text: '用户偏好简洁短回复' }]
          : [],
    });

    expect(run.preference.leakedCaseIds).toEqual(['pref-17']);
    expect(run.preference.stalePreferenceRate).toBeCloseTo(1 / 4, 10);
    // The current value never made it into the injected text either.
    expect(run.preference.mustContainMissIds).toContain('pref-17');
    expect(run.metrics.stalePreferenceRate).toBeCloseTo(1 / 4, 10);
  });

  it('counts inactive-status leakage and persona freshness from the injected ids', async () => {
    const dataset = loadKnowledgeEvalDataset(KNOWLEDGE_EVAL_DATASET_DIR);
    const lane = stubMemoryLane(dataset);
    const run = await runKnowledgeEval({
      retrieveMemories: lane.retrieve,
      statusLookup: (id) => (id === 'fop-dP01hXKQ-qgHAE3dA' ? 'superseded' : 'active'),
      personaUpdatedAt: 1_791_416_603_000,
      newestActiveMemoryUpdatedAt: 1_791_416_603_000 + PERSONA_FRESHNESS_TOLERANCE_MS + 1,
    });

    expect(run.statusLookupProvided).toBe(true);
    expect(run.metrics.inactiveLeakageCount).toBe(1);
    expect(run.metrics.personaFreshness).toBe('stale');
  });

  it('reports an empty run without dividing by zero', async () => {
    const run = await runKnowledgeEval({ retrieveMemories: async () => [] });

    expect(run.metrics.totalQueries).toBe(19);
    expect(run.metrics.queriesWithResults).toBe(0);
    expect(run.metrics.pAt5).toBe(0);
    expect(run.metrics.mrr).toBe(0);
    expect(run.metrics.keywordRecallAt5).toBe(0);
    expect(run.metrics.idRecallAt5).toBe(0);
    expect(run.metrics.averageRetrievalLatencyMs).toBeGreaterThanOrEqual(0);
    expect(run.preference.mustContainRate).toBe(0);
  });
});

describe('baseline files', () => {
  it('writes a dated baseline, reloads it, and finds the newest one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-baseline-'));
    const run: KnowledgeEvalRun = await runKnowledgeEval({
      retrieveMemories: async () => [],
    });

    const first = writeBaseline(run, dir, new Date(2026, 0, 5));
    expect(path.basename(first)).toBe('baseline-2026-01-05.json');
    expect(fs.existsSync(first)).toBe(true);

    const second = writeBaseline(run, dir, new Date(2026, 1, 1));
    expect(path.basename(second)).toBe('baseline-2026-02-01.json');
    // Unrelated files must not be mistaken for baselines.
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x', 'utf-8');

    expect(findLatestBaseline(dir)).toBe(second);

    const loaded = loadBaseline(second);
    expect(loaded.version).toBe(1);
    expect(loaded.metrics.totalQueries).toBe(run.metrics.totalQueries);
    expect(loaded.lanes).toEqual(['memories']);

    const diff = formatBaselineDiff(run.metrics, loaded);
    expect(diff).toContain('idRecall@5');
    expect(diff).toContain('MRR');
    expect(diff).toContain('personaFreshness');
  });

  it('returns null when no baseline exists yet', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-baseline-empty-'));
    expect(findLatestBaseline(dir)).toBeNull();
    expect(findLatestBaseline(path.join(dir, 'missing'))).toBeNull();
  });
});
