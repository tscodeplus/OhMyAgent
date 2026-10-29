/**
 * Knowledge eval harness (plan §6 K0, harness v2): the pure metric functions,
 * the JSONL/manifest loader's honesty rules, the fused-search contract, corpus
 * applicability, baseline versioning, and end-to-end runs against the real
 * `tests/eval/knowledge/*.jsonl` datasets with a stub search.
 *
 * Placed under tests/memory/ (not tests/knowledge/) because the code under test
 * lives in src/memory/eval/ — same directory as eval-runner.test.ts.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  BASELINE_FILE_VERSION,
  DEFAULT_TOP_K,
  HARNESS_VERSION,
  KNOWLEDGE_EVAL_DATASET_DIR,
  PERSONA_FRESHNESS_TOLERANCE_MS,
  computeCorpusFit,
  computeInactiveLeakageCount,
  computeKeywordRecallAt5,
  computeLatencyPercentiles,
  computePersonaFreshness,
  findLatestBaseline,
  formatBaselineDiff,
  formatKnowledgeEvalReport,
  loadBaseline,
  loadKnowledgeEvalDataset,
  loadKnowledgeEvalManifest,
  runKnowledgeEval,
  toEvalSearchResult,
  writeBaseline,
} from '../../src/memory/eval/knowledge-eval.js';
import type {
  EvalLane,
  EvalLaneRun,
  EvalSearchFn,
  EvalSearchHit,
  KnowledgeEvalDataset,
  KnowledgeEvalRun,
} from '../../src/memory/eval/knowledge-eval.js';
import type { GraphHint } from '../../src/graph/neighborhood.js';

const ALL_LANES: EvalLane[] = ['messages', 'memories', 'knowledge'];
const DEV_CORPUS = 'dev-machine';

interface TempDatasetFiles {
  episodic?: string;
  semantic?: string;
  preference?: string;
  graph?: string;
  manifest?: unknown;
}

const DEFAULT_MANIFEST = {
  version: 1,
  datasets: {
    episodic: { corpus: DEV_CORPUS },
    semantic: { corpus: DEV_CORPUS },
    preference: { corpus: DEV_CORPUS },
    graph: { corpus: DEV_CORPUS },
  },
};

function makeTempDatasetDir(files: TempDatasetFiles = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-eval-'));
  const manifest = files.manifest ?? DEFAULT_MANIFEST;
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
    'utf-8',
  );
  for (const name of ['episodic', 'semantic', 'preference', 'graph'] as const) {
    fs.writeFileSync(path.join(dir, `${name}.jsonl`), files[name] ?? '', 'utf-8');
  }
  return dir;
}

function jsonl(...entries: unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
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

describe('computeCorpusFit', () => {
  it('scores a corpus-specific dataset only on the corpus it was written for', () => {
    expect(computeCorpusFit({ corpus: DEV_CORPUS }, DEV_CORPUS).applicable).toBe(true);
    // Case/whitespace-insensitive, because the label comes from a CLI flag.
    expect(computeCorpusFit({ corpus: ' Dev-Machine ' }, DEV_CORPUS).applicable).toBe(true);

    const mismatch = computeCorpusFit({ corpus: DEV_CORPUS }, 'termux-device');
    expect(mismatch.applicable).toBe(false);
    expect(mismatch.reason).toContain(DEV_CORPUS);
    expect(mismatch.reason).toContain('termux-device');
  });

  it('treats an undeclared run as not applicable, and says how to declare it', () => {
    for (const undeclared of [null, undefined, '   ']) {
      const fit = computeCorpusFit({ corpus: DEV_CORPUS }, undeclared);
      expect(fit.applicable).toBe(false);
      expect(fit.reason).toContain('--corpus');
      expect(fit.reason).toContain(DEV_CORPUS);
    }
  });

  it('scores a portable dataset on any corpus, including an undeclared one', () => {
    expect(computeCorpusFit({ portable: true }, 'termux-device').applicable).toBe(true);
    expect(computeCorpusFit({ portable: true }, null).applicable).toBe(true);
  });

  it('refuses to guess when the dataset declares no corpus at all', () => {
    const fit = computeCorpusFit({}, DEV_CORPUS);
    expect(fit.applicable).toBe(false);
    expect(fit.reason).toContain('manifest.json');
  });
});

describe('loadKnowledgeEvalManifest', () => {
  it('reads the shipped corpus declarations', () => {
    const manifest = loadKnowledgeEvalManifest(KNOWLEDGE_EVAL_DATASET_DIR);
    expect(manifest.version).toBe(1);
    for (const name of ['episodic', 'semantic', 'preference', 'graph'] as const) {
      expect(manifest.datasets[name].corpus).toBe(DEV_CORPUS);
      expect(manifest.datasets[name].portable).toBeUndefined();
    }
  });

  it('requires a corpus or a portable declaration per dataset', () => {
    for (const declaration of [{}, { note: 'no corpus' }]) {
      const dir = makeTempDatasetDir({
        manifest: {
          version: 1,
          datasets: {
            episodic: declaration,
            semantic: declaration,
            preference: declaration,
            graph: declaration,
          },
        },
      });
      expect(() => loadKnowledgeEvalManifest(dir)).toThrow(/must declare "corpus".*or "portable"/);
    }
  });

  it('rejects a declaration that is both corpus-specific and portable', () => {
    const dir = makeTempDatasetDir({
      manifest: {
        version: 1,
        datasets: {
          episodic: { corpus: DEV_CORPUS, portable: true },
          semantic: { corpus: DEV_CORPUS },
          preference: { corpus: DEV_CORPUS },
          graph: { corpus: DEV_CORPUS },
        },
      },
    });
    expect(() => loadKnowledgeEvalManifest(dir)).toThrow(/both "corpus" and "portable"/);
  });

  it('refuses a dataset directory without a manifest instead of assuming a corpus', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-eval-nomanifest-'));
    expect(() => loadKnowledgeEvalManifest(dir)).toThrow(/manifest\.json: missing/);
  });

  it('refuses an unknown manifest version', () => {
    const dir = makeTempDatasetDir({
      manifest: { version: 99, datasets: DEFAULT_MANIFEST.datasets },
    });
    expect(() => loadKnowledgeEvalManifest(dir)).toThrow(/unsupported manifest version 99/);
  });
});

describe('loadKnowledgeEvalDataset', () => {
  it('loads the shipped datasets with the sizes the plan specifies', () => {
    const dataset = loadKnowledgeEvalDataset(KNOWLEDGE_EVAL_DATASET_DIR);
    expect(dataset.episodic).toHaveLength(10);
    expect(dataset.semantic).toHaveLength(15);
    expect(dataset.preference).toHaveLength(20);
    // Three relation questions plus the mention-only negative case.
    expect(dataset.graph).toHaveLength(4);
    expect(dataset.graph.filter((c) => c.forbiddenNeighbours.length > 0)).toHaveLength(1);
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
      episodic: '{"id":"e1","query":"q","expectedMessageIds":["m1"]}\nnot json\n',
    });
    expect(() => loadKnowledgeEvalDataset(dir)).toThrow(/episodic\.jsonl:2: invalid JSON/);
  });

  it('rejects duplicate case ids', () => {
    const dir = makeTempDatasetDir({
      episodic: jsonl(
        { id: 'e1', query: 'q1', expectedMessageIds: ['m1'] },
        { id: 'e1', query: 'q2', expectedMessageIds: ['m2'] },
      ),
    });
    expect(() => loadKnowledgeEvalDataset(dir)).toThrow(/duplicate case id "e1"/);
  });

  it('rejects a labelled case with no golden', () => {
    const dir = makeTempDatasetDir({
      semantic: jsonl({ id: 's1', query: 'q', expectedKeywords: [] }),
    });
    expect(() => loadKnowledgeEvalDataset(dir)).toThrow(
      /labelled case "s1" needs expectedKeywords or expectedMemoryIds/,
    );
  });
});

// ─── Stub fused search ───

/**
 * A `unifiedSearch()` stand-in that answers every labelled case from its own
 * golden, so the harness's plumbing is exercised without a database or a model.
 * Hits are lane-tagged exactly as the live adapter tags them.
 */
function stubFusedSearch(
  dataset: KnowledgeEvalDataset,
  options: { lanes?: EvalLane[]; delayMs?: number } = {},
): { search: EvalSearchFn; queried: Array<{ query: string; topK: number }> } {
  const lanes = options.lanes ?? ALL_LANES;
  const byQuery = new Map<string, EvalSearchHit[]>();
  for (const evalCase of dataset.episodic) {
    byQuery.set(
      evalCase.query,
      evalCase.expectedMessageIds.map((id) => ({ lane: 'messages' as const, id, text: '' })),
    );
  }
  for (const evalCase of dataset.semantic) {
    const text = evalCase.expectedKeywords.join(' ');
    byQuery.set(
      evalCase.query,
      (evalCase.expectedMemoryIds ?? []).map((id) => ({ lane: 'memories' as const, id, text })),
    );
  }
  for (const evalCase of dataset.preference) {
    byQuery.set(
      evalCase.query,
      evalCase.mustContain.length > 0
        ? [{ lane: 'memories', id: `mem-for-${evalCase.id}`, text: evalCase.mustContain.join(' ') }]
        : [],
    );
  }
  const queried: Array<{ query: string; topK: number }> = [];
  const search: EvalSearchFn = async (query, topK) => {
    queried.push({ query, topK });
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    // A hit from a lane the caller did not report as running would be a lying
    // stub, not a lane the harness can attribute — see the runner's note on it.
    const hits = (byQuery.get(query) ?? [])
      .filter((hit) => lanes.includes(hit.lane))
      .slice(0, topK);
    const reports: Partial<Record<EvalLane, EvalLaneRun>> = {};
    for (const lane of lanes) {
      reports[lane] = { hits: hits.filter((hit) => hit.lane === lane).length, dropped: 0 };
    }
    return { hits, lanes: reports };
  };
  return { search, queried };
}

describe('runKnowledgeEval (fused three-lane harness)', () => {
  it('scores the fused list every lane contributes to, not one primary lane', async () => {
    const dataset = loadKnowledgeEvalDataset(KNOWLEDGE_EVAL_DATASET_DIR);
    const stub = stubFusedSearch(dataset, { delayMs: 2 });
    const run = await runKnowledgeEval({
      search: stub.search,
      datasetDir: KNOWLEDGE_EVAL_DATASET_DIR,
      corpus: DEV_CORPUS,
    });

    // All three lanes were measured — the headline fix over the K0 harness,
    // which wired the memory lane alone and scored episodic 0 by construction.
    expect(run.lanes).toEqual(ALL_LANES);
    expect(run.unwiredLanes).toEqual([]);
    // This corpus has no knowledge page matching these questions, so the lane
    // ran and returned nothing. That is not the same as not being wired, which
    // is why the two are separate fields.
    expect(run.lanesWithHits).toEqual(['messages', 'memories']);
    expect(run.harnessVersion).toBe(HARNESS_VERSION);
    expect(run.topK).toBe(DEFAULT_TOP_K);
    expect(run.corpus).toBe(DEV_CORPUS);
    expect(run.statusLookupProvided).toBe(false);

    // The episodic goldens are message ids and they now count.
    expect(run.episodic.labelled).toBe(9);
    expect(run.episodic.unlabelled).toBe(1);
    expect(run.episodic.unlabelledIds).toEqual(['ep-10']);
    expect(run.episodic.idRecallAt5).toBe(1);
    expect(run.episodic.mrr).toBe(1);

    expect(run.semantic.labelled).toBe(10);
    expect(run.semantic.unlabelled).toBe(5);
    expect(run.semantic.idRecallAt5).toBe(1);
    expect(run.semantic.keywordRecallAt5).toBe(1);
    expect(run.semantic.keywordCases).toBe(10);
    expect(run.semantic.missedCaseIds).toEqual([]);

    // Aggregate = micro-average over the 19 id-labelled cases.
    expect(run.metrics.totalQueries).toBe(19);
    expect(run.metrics.queriesWithResults).toBe(19);
    expect(run.metrics.idRecallAt5).toBe(1);
    expect(run.metrics.keywordRecallAt5).toBe(1);
    expect(run.metrics.mrr).toBe(1);
    expect(run.metrics.rAt5).toBe(1);
    expect(run.metrics.rAt10).toBe(1);
    // P@5 keeps `computeMetrics`'s definition: relevant-in-top-5 over 5.
    expect(run.metrics.pAt5).not.toBeNull();
    expect(run.metrics.pAt5).toBeGreaterThan(0);
    expect(run.metrics.pAt5).toBeLessThanOrEqual(1);

    // Nothing is averaged into a not-applicable dataset, and every reason is stated.
    expect(run.datasetApplicability.every((fit) => fit.applicable)).toBe(true);
    expect(run.datasetApplicability.every((fit) => fit.reason.length > 0)).toBe(true);

    // Preference: the stub returns each case's own mustContain text, so the
    // stale/contain mechanics are exercised without claiming a real result.
    expect(run.preference.labelled).toBe(19);
    expect(run.preference.unlabelled).toBe(1);
    expect(run.preference.staleCases).toBe(4);
    expect(run.preference.stalePreferenceRate).toBe(0);
    expect(run.preference.mustContainCases).toBe(19);
    expect(run.preference.mustContainRate).toBe(1);

    // Timing is measured per search call, so the stub's delay shows up.
    expect(run.metrics.averageRetrievalLatencyMs).toBeGreaterThanOrEqual(1);
    expect(run.metrics.latencyP95Ms).toBeGreaterThanOrEqual(run.metrics.latencyP50Ms ?? 0);

    // The honest status line prints both halves.
    expect(run.summary).toContain('lanes wired: messages');
    expect(run.summary).toContain('not wired: (none)');
    expect(formatKnowledgeEvalReport(run)).toContain('personaFreshness: unknown');
  });

  it('attributes each hit to the lane that produced it, and scores lanes separately', async () => {
    const dir = makeTempDatasetDir({
      episodic: jsonl({ id: 'e1', query: 'who said it', expectedMessageIds: ['msg-1'] }),
    });
    const search: EvalSearchFn = async (query, topK) => {
      const hits: EvalSearchHit[] = [
        // A memory that answers nothing, fused ahead of the message that does.
        { lane: 'memories', id: 'mem-noise', text: 'unrelated memory' },
        { lane: 'messages', id: 'msg-1', text: 'the message that answers' },
      ];
      return {
        hits: hits.slice(0, topK),
        lanes: {
          messages: { hits: 1, dropped: 0 },
          memories: { hits: 1, dropped: 0 },
          knowledge: { hits: 0, dropped: 0 },
        },
      };
    };

    const run = await runKnowledgeEval({ search, datasetDir: dir, corpus: DEV_CORPUS });
    expect(run.lanes).toEqual(ALL_LANES);
    // The knowledge lane ran and contributed nothing — that is not "not wired".
    expect(run.lanesWithHits).toEqual(['messages', 'memories']);

    const messages = run.byLane.find((row) => row.lane === 'messages');
    const memories = run.byLane.find((row) => row.lane === 'memories');
    const knowledge = run.byLane.find((row) => row.lane === 'knowledge');
    expect(messages).toMatchObject({
      hits: 1,
      queriesWithHits: 1,
      idCases: 1,
      idCasesWithHit: 1,
      idRecallAt5: 1,
      precisionAt5: 1,
    });
    expect(memories).toMatchObject({
      hits: 1,
      idCasesWithHit: 0,
      idRecallAt5: 0,
      precisionAt5: 0,
    });
    expect(knowledge).toMatchObject({
      hits: 0,
      queriesWithHits: 0,
      idRecallAt5: 0,
      precisionAt5: null,
    });

    // Per-case attribution names the lane behind each hit and the matching id.
    const [attribution] = run.cases;
    expect(attribution.id).toBe('e1');
    expect(attribution.scored).toBe(true);
    expect(attribution.hits).toEqual([
      { lane: 'memories', id: 'mem-noise' },
      { lane: 'messages', id: 'msg-1' },
    ]);
    expect(attribution.matchedIds).toEqual([{ lane: 'messages', id: 'msg-1' }]);

    // Recall at the aggregate level is still a hit: one lane found it.
    expect(run.metrics.idRecallAt5).toBe(1);
    // MRR@5 is 0.5 because the relevant hit is second in the fused order.
    expect(run.metrics.mrr).toBe(0.5);
  });

  it('keeps R@10 a real depth-10 measurement instead of aliasing R@5', async () => {
    const dir = makeTempDatasetDir({
      episodic: jsonl({ id: 'e1', query: 'q', expectedMessageIds: ['msg-6'] }),
    });
    const queried: number[] = [];
    const search: EvalSearchFn = async (query, topK) => {
      queried.push(topK);
      return {
        hits: Array.from({ length: 6 }, (_, index) => ({
          lane: 'messages' as const,
          id: `msg-${index + 1}`,
          text: `body ${index + 1}`,
        })).slice(0, topK),
        lanes: { messages: { hits: 6, dropped: 0 } },
      };
    };

    const run = await runKnowledgeEval({ search, datasetDir: dir, corpus: DEV_CORPUS });
    // The harness asks for at least 10 results; the injected metrics use 5.
    expect(queried).toEqual([10]);
    expect(run.topK).toBe(5);
    expect(run.episodic.idRecallAt5).toBe(0);
    expect(run.episodic.rAt5).toBe(0);
    expect(run.episodic.rAt10).toBe(1);
    expect(run.episodic.mrr).toBeCloseTo(1 / 6, 10);
  });

  it('scores a knowledge-lane hit, so the page lane is part of the measurement too', async () => {
    const dir = makeTempDatasetDir({
      semantic: jsonl({
        id: 's1',
        query: 'what is written down',
        expectedMemoryIds: ['page-1'],
        expectedKeywords: ['curated fact'],
      }),
    });
    const search: EvalSearchFn = async (query, topK) => {
      const hits: EvalSearchHit[] = [{ lane: 'knowledge', id: 'page-1', text: 'the curated fact' }];
      return {
        hits: hits.slice(0, topK),
        lanes: {
          messages: { hits: 0, dropped: 0 },
          memories: { hits: 0, dropped: 0 },
          knowledge: { hits: 1, dropped: 0 },
        },
      };
    };

    const run = await runKnowledgeEval({ search, datasetDir: dir, corpus: DEV_CORPUS });
    expect(run.lanesWithHits).toEqual(['knowledge']);
    expect(run.semantic.idRecallAt5).toBe(1);
    expect(run.semantic.keywordRecallAt5).toBe(1);
    const knowledge = run.byLane.find((row) => row.lane === 'knowledge');
    expect(knowledge).toMatchObject({ idCasesWithHit: 1, idRecallAt5: 1, precisionAt5: 1 });
    expect(run.cases[0].matchedIds).toEqual([{ lane: 'knowledge', id: 'page-1' }]);
  });

  it('reports a lane that was never wired instead of printing silence', async () => {
    const dataset = loadKnowledgeEvalDataset(KNOWLEDGE_EVAL_DATASET_DIR);
    const stub = stubFusedSearch(dataset, { lanes: ['memories'] });
    const run = await runKnowledgeEval({
      search: stub.search,
      datasetDir: KNOWLEDGE_EVAL_DATASET_DIR,
      corpus: DEV_CORPUS,
    });

    expect(run.lanes).toEqual(['memories']);
    expect(run.unwiredLanes).toEqual(['messages', 'knowledge']);
    expect(run.summary).toContain('not wired: messages, knowledge');
    // An episodic golden cannot be found by a lane that never ran, and this 0
    // is now an honest measurement of the wired set rather than of nothing.
    expect(run.episodic.idRecallAt5).toBe(0);
    expect(run.semantic.idRecallAt5).toBe(1);
  });

  it('reports per-lane failures without dropping the other lanes', async () => {
    const dir = makeTempDatasetDir({
      semantic: jsonl({ id: 's1', query: 'q', expectedMemoryIds: ['mem-1'], expectedKeywords: [] }),
    });
    const search: EvalSearchFn = async () => ({
      hits: [{ lane: 'memories', id: 'mem-1', text: '' }],
      lanes: {
        messages: { hits: 0, dropped: 0, error: 'FTS table missing' },
        memories: { hits: 1, dropped: 0 },
      },
    });

    const run = await runKnowledgeEval({ search, datasetDir: dir, corpus: DEV_CORPUS });
    expect(run.laneErrors).toEqual([{ lane: 'messages', message: 'FTS table missing' }]);
    expect(run.summary).toContain('lane errors: messages — FTS table missing');
    expect(run.semantic.idRecallAt5).toBe(1);
  });

  it('never queries an unlabelled case', async () => {
    const dataset = loadKnowledgeEvalDataset(KNOWLEDGE_EVAL_DATASET_DIR);
    const stub = stubFusedSearch(dataset);
    await runKnowledgeEval({
      search: stub.search,
      datasetDir: KNOWLEDGE_EVAL_DATASET_DIR,
      corpus: DEV_CORPUS,
    });

    const unlabelledQueries = new Set(
      [...dataset.episodic, ...dataset.semantic, ...dataset.preference]
        .filter((c) => c.unlabelled)
        .map((c) => c.query),
    );
    expect(unlabelledQueries.size).toBe(7);
    for (const { query } of stub.queried) {
      expect(unlabelledQueries.has(query)).toBe(false);
    }
  });

  it('scores a superseded value leak as a stale preference', async () => {
    const dataset = loadKnowledgeEvalDataset(KNOWLEDGE_EVAL_DATASET_DIR);
    const changedCase = dataset.preference.find((c) => c.id === 'pref-17');
    if (!changedCase) throw new Error('pref-17 missing from the preference dataset');

    const run = await runKnowledgeEval({
      datasetDir: KNOWLEDGE_EVAL_DATASET_DIR,
      corpus: DEV_CORPUS,
      // Only pref-17's query gets the superseded row back — the failure mode
      // G1's stalePreferenceRate exists to catch.
      search: async (query) =>
        query === changedCase.query
          ? {
              hits: [{ lane: 'memories', id: 'rWqtT5zTH68NdtJadc_B-', text: '用户偏好简洁短回复' }],
              lanes: { memories: { hits: 1, dropped: 0 } },
            }
          : { hits: [], lanes: { memories: { hits: 0, dropped: 0 } } },
    });

    expect(run.preference.leakedCaseIds).toEqual(['pref-17']);
    expect(run.preference.stalePreferenceRate).toBeCloseTo(1 / 4, 10);
    // The current value never made it into the injected text either.
    expect(run.preference.mustContainMissIds).toContain('pref-17');
    expect(run.metrics.stalePreferenceRate).toBeCloseTo(1 / 4, 10);
  });

  it('counts inactive-status leakage and persona freshness from the injected ids', async () => {
    const dataset = loadKnowledgeEvalDataset(KNOWLEDGE_EVAL_DATASET_DIR);
    const stub = stubFusedSearch(dataset);
    const run = await runKnowledgeEval({
      search: stub.search,
      datasetDir: KNOWLEDGE_EVAL_DATASET_DIR,
      corpus: DEV_CORPUS,
      statusLookup: (id) => (id === 'fop-dP01hXKQ-qgHAE3dA' ? 'superseded' : 'active'),
      personaUpdatedAt: 1_791_416_603_000,
      newestActiveMemoryUpdatedAt: 1_791_416_603_000 + PERSONA_FRESHNESS_TOLERANCE_MS + 1,
    });

    expect(run.statusLookupProvided).toBe(true);
    expect(run.metrics.inactiveLeakageCount).toBe(1);
    expect(run.metrics.personaFreshness).toBe('stale');
  });

  it('reports 0 — not "not applicable" — when the right corpus simply returned nothing', async () => {
    const run = await runKnowledgeEval({
      datasetDir: KNOWLEDGE_EVAL_DATASET_DIR,
      corpus: DEV_CORPUS,
      search: async () => ({ hits: [], lanes: { messages: { hits: 0 }, memories: { hits: 0 } } }),
    });

    expect(run.metrics.totalQueries).toBe(19);
    expect(run.metrics.queriesWithResults).toBe(0);
    expect(run.metrics.pAt5).toBe(0);
    expect(run.metrics.mrr).toBe(0);
    expect(run.metrics.keywordRecallAt5).toBe(0);
    expect(run.metrics.idRecallAt5).toBe(0);
    expect(run.preference.mustContainRate).toBe(0);
    expect(run.metrics.averageRetrievalLatencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('runKnowledgeEval corpus applicability', () => {
  it('reports not applicable, not 0%, on a corpus the dataset was not written for', async () => {
    const dataset = loadKnowledgeEvalDataset(KNOWLEDGE_EVAL_DATASET_DIR);
    const stub = stubFusedSearch(dataset);
    const run = await runKnowledgeEval({
      search: stub.search,
      datasetDir: KNOWLEDGE_EVAL_DATASET_DIR,
      corpus: 'termux-device',
    });

    expect(run.corpus).toBe('termux-device');
    // Nothing is scored: every metric that would need the goldens is null.
    expect(run.episodic.applicable).toBe(false);
    expect(run.episodic.applicabilityReason).toContain(DEV_CORPUS);
    expect(run.episodic.applicabilityReason).toContain('termux-device');
    expect(run.episodic.idRecallAt5).toBeNull();
    expect(run.episodic.mrr).toBeNull();
    expect(run.semantic.keywordRecallAt5).toBeNull();
    expect(run.preference.stalePreferenceRate).toBeNull();
    expect(run.metrics.idRecallAt5).toBeNull();
    expect(run.metrics.keywordRecallAt5).toBeNull();
    expect(run.metrics.pAt5).toBeNull();
    expect(run.metrics.stalePreferenceRate).toBeNull();

    // The searches still ran — latency is corpus-independent — so the run is
    // not empty, it is unscored, and it says so.
    expect(run.metrics.averageRetrievalLatencyMs).not.toBeNull();
    expect(run.summary).toContain('NOT APPLICABLE');
    expect(run.summary).toContain(`corpus: termux-device`);
    // Every case keeps its lane attribution but is marked unscored with a reason.
    expect(run.cases.length).toBeGreaterThan(0);
    expect(run.cases.every((entry) => !entry.scored)).toBe(true);
    expect(run.cases.every((entry) => (entry.skippedReason ?? '').length > 0)).toBe(true);
  });

  it('says how to declare the corpus when the run declares none', async () => {
    const run = await runKnowledgeEval({
      datasetDir: KNOWLEDGE_EVAL_DATASET_DIR,
      search: async () => ({ hits: [], lanes: {} }),
    });

    expect(run.corpus).toBeNull();
    expect(run.metrics.idRecallAt5).toBeNull();
    expect(run.episodic.applicabilityReason).toContain('--corpus');
    expect(run.summary).toContain('corpus: (undeclared)');
    // No search function reported a lane, and the status line says so.
    expect(run.lanes).toEqual([]);
    expect(run.unwiredLanes).toEqual(ALL_LANES);
    expect(run.summary).toContain('lanes wired: (none)');
    expect(run.summary).toContain('not wired: messages, memories, knowledge');
  });

  it('scores a portable dataset on a foreign corpus, excluding goldens that are absent', async () => {
    const dir = makeTempDatasetDir({
      manifest: {
        version: 1,
        datasets: {
          episodic: { portable: true },
          semantic: { portable: true },
          preference: { portable: true },
          graph: { portable: true },
        },
      },
      episodic: jsonl(
        { id: 'e-present', query: 'q1', expectedMessageIds: ['msg-1'] },
        { id: 'e-absent', query: 'q2', expectedMessageIds: ['msg-gone'] },
      ),
      semantic: jsonl({
        id: 's1',
        query: 'q3',
        expectedMemoryIds: ['mem-1'],
        expectedKeywords: ['keyword'],
      }),
    });
    const search: EvalSearchFn = async (query) => {
      const table: Record<string, EvalSearchHit[]> = {
        q1: [{ lane: 'messages', id: 'msg-1', text: 'present' }],
        q2: [],
        q3: [{ lane: 'memories', id: 'mem-1', text: 'the keyword' }],
      };
      const hits = table[query] ?? [];
      return {
        hits,
        lanes: {
          messages: { hits: hits.filter((h) => h.lane === 'messages').length },
          memories: { hits: hits.filter((h) => h.lane === 'memories').length },
        },
      };
    };

    const run = await runKnowledgeEval({
      search,
      datasetDir: dir,
      corpus: 'termux-device',
      idExists: (id) => id !== 'msg-gone',
    });

    expect(run.datasetApplicability.every((fit) => fit.applicable)).toBe(true);
    // The absent golden is excluded from scoring rather than booked as a miss.
    expect(run.episodic.unresolvableIds).toEqual(['e-absent']);
    expect(run.episodic.labelled).toBe(1);
    expect(run.episodic.idRecallAt5).toBe(1);
    expect(run.semantic.keywordRecallAt5).toBe(1);
    expect(run.metrics.idRecallAt5).toBe(1);
    const skipped = run.cases.find((entry) => entry.id === 'e-absent');
    expect(skipped?.scored).toBe(false);
    expect(skipped?.skippedReason).toContain('absent from this corpus');
  });
});

describe('toEvalSearchResult (unifiedSearch wiring)', () => {
  it('maps the fused lanes, refs and snippets the harness scores', () => {
    const result = toEvalSearchResult(
      {
        hits: [
          { lane: 'message', ref: 'msg-1', snippet: 'the message' },
          { lane: 'memory', ref: 'mem-1', snippet: 'the memory' },
          { lane: 'knowledge', ref: 'page-1', snippet: 'the page' },
        ],
        lanes: {
          message: { hits: 1, dropped: 0 },
          memory: { hits: 3, dropped: 2 },
          knowledge: { hits: 1, dropped: 0, error: 'fts unavailable' },
        },
      },
      ['message', 'memory', 'knowledge'],
    );

    expect(result.hits).toEqual([
      { lane: 'messages', id: 'msg-1', text: 'the message' },
      { lane: 'memories', id: 'mem-1', text: 'the memory' },
      { lane: 'knowledge', id: 'page-1', text: 'the page' },
    ]);
    expect(result.lanes.messages).toEqual({ hits: 1, dropped: 0 });
    expect(result.lanes.memories).toEqual({ hits: 3, dropped: 2 });
    expect(result.lanes.knowledge).toEqual({ hits: 1, dropped: 0, error: 'fts unavailable' });
  });

  it('reports only the lanes the caller requested, so "not wired" stays visible', () => {
    const result = toEvalSearchResult(
      {
        hits: [],
        lanes: {
          message: { hits: 0, dropped: 0 },
          memory: { hits: 0, dropped: 0 },
          knowledge: { hits: 0, dropped: 0 },
        },
      },
      ['message', 'memory'],
    );
    expect(Object.keys(result.lanes).sort()).toEqual(['memories', 'messages']);
  });
});

describe('graph lane', () => {
  const NEIGHBOUR = { subject: 'excel-mcp', relation: 'USES', object: 'Power Query' };
  const HINT: GraphHint = {
    subject: 'excel-mcp',
    relation: 'USES',
    object: 'Power Query',
    memoryId: 'mem-edge',
    memoryRef: 'mem-edge',
  };

  const noSearch: EvalSearchFn = async () => ({ hits: [], lanes: {} });

  function graphRun(options: {
    cases: unknown[];
    hintsFor?: (memoryIds: string[]) => GraphHint[];
    search?: EvalSearchFn;
  }) {
    const dir = makeTempDatasetDir({ graph: jsonl(...options.cases) });
    return runKnowledgeEval({
      search: options.search ?? noSearch,
      datasetDir: dir,
      corpus: DEV_CORPUS,
      ...(options.hintsFor ? { hintsFor: options.hintsFor } : {}),
    });
  }

  it('scores a relation the hint block presents', async () => {
    const run = await graphRun({
      cases: [
        {
          id: 'g1',
          query: 'excel-mcp 怎么读 Excel？',
          seedMemoryIds: ['mem-edge'],
          expectedNeighbours: [NEIGHBOUR],
        },
      ],
      hintsFor: () => [HINT],
    });

    expect(run.graph.applicable).toBe(true);
    expect(run.graph.labelled).toBe(1);
    expect(run.graph.casesWithAllNeighbours).toBe(1);
    expect(run.graph.neighbourAssertions).toBe(1);
    expect(run.graph.neighbourRecall).toBe(1);
    expect(run.graph.missedCaseIds).toEqual([]);
    expect(run.graph.hintsPresented).toBe(1);
    // The lane is printed even though it feeds no fused metric.
    expect(run.summary).toContain('neighbourRecall 100.0%');
  });

  it('seeds from the query’s memory hits when the case pins no seeds', async () => {
    const seen: string[][] = [];
    const query = 'excel-mcp 怎么读 Excel？';
    const search: EvalSearchFn = async () => ({
      hits: [{ lane: 'memories', id: 'mem-recalled', text: 'excel-mcp … Power Query' }],
      lanes: { memories: { hits: 1, dropped: 0 } },
    });

    const run = await graphRun({
      cases: [{ id: 'g1', query, expectedNeighbours: [NEIGHBOUR] }],
      search,
      hintsFor: (ids) => {
        seen.push(ids);
        return [HINT];
      },
    });

    // Pinned seeds are the only reason a graph query is not searched, so the
    // unpinned case has to reach the retriever exactly as `memory_recall` does.
    expect(seen).toEqual([['mem-recalled']]);
    expect(run.graph.neighbourRecall).toBe(1);
  });

  it('reports a miss when the hint block does not hold the relation', async () => {
    const run = await graphRun({
      cases: [
        {
          id: 'g-missing',
          query: 'excel-mcp 怎么读 Excel？',
          seedMemoryIds: ['mem-other'],
          expectedNeighbours: [NEIGHBOUR],
        },
      ],
      hintsFor: () => [],
    });

    expect(run.graph.neighbourRecall).toBe(0);
    expect(run.graph.missedCaseIds).toEqual(['g-missing']);
    expect(run.graph.casesWithAllNeighbours).toBe(0);
    // An empty block is not an error — it is the ordinary case on a graph with
    // no edge among the recalled memories.
    expect(run.graph.applicable).toBe(true);
  });

  it('flags a mention-only pair presented as a relation', async () => {
    const run = await graphRun({
      cases: [
        {
          id: 'g-negative',
          query: 'excel-mcp 会用 Python 处理 Excel 吗？',
          seedMemoryIds: ['mem-edge'],
          expectedNeighbours: [NEIGHBOUR],
          forbiddenNeighbours: [{ subject: 'Python', object: 'Excel' }],
        },
      ],
      // The same memory mentions Python and Excel; here the projection has
      // dressed that co-occurrence as a statement, which the lane must catch.
      hintsFor: () => [
        HINT,
        {
          subject: 'Python',
          relation: 'USES',
          object: 'Excel',
          memoryId: 'mem-edge',
          memoryRef: 'mem-edge',
        },
      ],
    });

    expect(run.graph.negativeCases).toBe(1);
    expect(run.graph.negativePassRate).toBe(0);
    expect(run.graph.mentionOnlyLeakIds).toEqual(['g-negative']);
    expect(run.summary).toContain('mentionOnlyLeaks 1');
  });

  it('passes the negative half when the block holds relations but not that pair', async () => {
    const run = await graphRun({
      cases: [
        {
          id: 'g-clean',
          query: 'excel-mcp 会用 Python 处理 Excel 吗？',
          seedMemoryIds: ['mem-edge'],
          forbiddenNeighbours: [{ subject: 'Python', object: 'Excel' }],
        },
      ],
      hintsFor: () => [HINT],
    });

    expect(run.graph.negativeCases).toBe(1);
    expect(run.graph.negativePassRate).toBe(1);
    expect(run.graph.mentionOnlyLeakIds).toEqual([]);
    // The expected-neighbour half is empty here, so it is not scored as a hit.
    expect(run.graph.neighbourAssertions).toBe(0);
    expect(run.graph.neighbourRecall).toBeNull();
  });

  it('reports the lane as not measured when no hints provider is wired', async () => {
    const run = await graphRun({
      cases: [
        { id: 'g1', query: 'q', seedMemoryIds: ['mem-edge'], expectedNeighbours: [NEIGHBOUR] },
      ],
    });

    expect(run.graph.applicable).toBe(false);
    expect(run.graph.applicabilityReason).toContain('no hints provider');
    expect(run.graph.neighbourRecall).toBeNull();
    expect(run.summary).toContain('not measured');
  });

  it('reports a throwing provider instead of scoring it as a miss', async () => {
    const run = await graphRun({
      cases: [
        { id: 'g1', query: 'q', seedMemoryIds: ['mem-edge'], expectedNeighbours: [NEIGHBOUR] },
      ],
      hintsFor: () => {
        throw new Error('graph tables missing');
      },
    });

    expect(run.graph.providerError).toBe('graph tables missing');
    expect(run.graph.applicable).toBe(false);
    expect(run.graph.missedCaseIds).toEqual([]);
    expect(run.graph.neighbourRecall).toBeNull();
  });

  it('refuses a labelled graph case with nothing to assert', () => {
    const dir = makeTempDatasetDir({
      graph: jsonl({ id: 'g1', query: 'q', expectedNeighbours: [], forbiddenNeighbours: [] }),
    });
    expect(() => loadKnowledgeEvalDataset(dir)).toThrow(
      /labelled case "g1" needs expectedNeighbours or forbiddenNeighbours/,
    );
  });

  it('rejects a neighbour triple with a missing field', () => {
    const dir = makeTempDatasetDir({
      graph: jsonl({
        id: 'g1',
        query: 'q',
        expectedNeighbours: [{ subject: 'a', object: 'b' }],
      }),
    });
    expect(() => loadKnowledgeEvalDataset(dir)).toThrow(/expectedNeighbours\[0\]: "relation"/);
  });
});

describe('baseline files', () => {
  async function sampleRun(): Promise<KnowledgeEvalRun> {
    const dataset = loadKnowledgeEvalDataset(KNOWLEDGE_EVAL_DATASET_DIR);
    return runKnowledgeEval({
      search: stubFusedSearch(dataset).search,
      datasetDir: KNOWLEDGE_EVAL_DATASET_DIR,
      corpus: DEV_CORPUS,
    });
  }

  it('writes a dated baseline, reloads it, and finds the newest one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-baseline-'));
    const run = await sampleRun();

    const first = writeBaseline(run, dir, new Date(2026, 0, 5));
    expect(path.basename(first)).toBe('baseline-2026-01-05.json');
    expect(fs.existsSync(first)).toBe(true);

    const second = writeBaseline(run, dir, new Date(2026, 1, 1));
    expect(path.basename(second)).toBe('baseline-2026-02-01.json');
    // Unrelated files must not be mistaken for baselines.
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x', 'utf-8');

    expect(findLatestBaseline(dir)).toBe(second);

    const loaded = loadBaseline(second);
    expect(loaded.version).toBe(BASELINE_FILE_VERSION);
    expect(loaded.harnessVersion).toBe(HARNESS_VERSION);
    expect(loaded.lanes).toEqual(ALL_LANES);
    expect(loaded.corpus).toBe(DEV_CORPUS);
    expect(loaded.metrics.totalQueries).toBe(run.metrics.totalQueries);

    const diff = formatBaselineDiff(run, loaded);
    expect(diff.status).toBe('compared');
    expect(diff.text).toContain('idRecall@5');
    expect(diff.text).toContain('MRR');
    expect(diff.text).toContain('personaFreshness');
    expect(diff.text).toContain(`harness v${HARNESS_VERSION}`);
  });

  it('returns null when no baseline exists yet', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-baseline-empty-'));
    expect(findLatestBaseline(dir)).toBeNull();
    expect(findLatestBaseline(path.join(dir, 'missing'))).toBeNull();
  });

  it('refuses to diff a baseline written by another harness version', async () => {
    const run = await sampleRun();
    const loaded = { ...writeAndLoad(run), harnessVersion: HARNESS_VERSION - 1 };

    const diff = formatBaselineDiff(run, loaded);
    expect(diff.status).toBe('refused');
    expect(diff.reason).toContain('harnessVersion');
    expect(diff.text).toContain('REFUSED');
    expect(diff.text).toContain('--baseline');
    // No delta table at all: a subtraction of unlike things is not printed.
    expect(diff.text).not.toContain('idRecall@5');
  });

  it('refuses the pre-v2 baseline files that carry no harnessVersion', async () => {
    const run = await sampleRun();
    const legacy = {
      ...writeAndLoad(run),
      version: 1,
      harnessVersion: undefined,
    } as unknown as ReturnType<typeof loadBaseline>;

    const diff = formatBaselineDiff(run, legacy);
    expect(diff.status).toBe('refused');
    expect(diff.reason).toContain('file shape version 1');
    expect(diff.reason).toContain('harnessVersion');
  });

  it('refuses to diff across a different lane set', async () => {
    const run = await sampleRun();
    const singleLane = { ...writeAndLoad(run), lanes: ['memories' as EvalLane] };

    const diff = formatBaselineDiff(run, singleLane);
    expect(diff.status).toBe('refused');
    expect(diff.reason).toContain('measured lanes [memories]');
    expect(diff.reason).toContain(`[${[...run.lanes].sort().join(',')}]`);
  });

  it('refuses to diff across a different corpus', async () => {
    const run = await sampleRun();
    const foreignCorpus = { ...writeAndLoad(run), corpus: 'termux-device' };

    const diff = formatBaselineDiff(run, foreignCorpus);
    expect(diff.status).toBe('refused');
    expect(diff.reason).toContain('termux-device');
    expect(diff.reason).toContain(DEV_CORPUS);
  });

  it('prints n/a instead of a fake delta for a metric neither side scored', async () => {
    const run = await sampleRun();
    const baseline = writeAndLoad(run);
    const withNulls = {
      ...baseline,
      metrics: { ...baseline.metrics, keywordRecallAt5: null },
    };

    const diff = formatBaselineDiff(
      { ...run, metrics: { ...run.metrics, keywordRecallAt5: null } },
      withNulls,
    );
    expect(diff.status).toBe('compared');
    const keywordLine = diff.text.split('\n').find((line) => line.startsWith('keywordRecall@5'));
    expect(keywordLine).toContain('n/a');
  });

  function writeAndLoad(run: KnowledgeEvalRun) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-baseline-diff-'));
    return loadBaseline(writeBaseline(run, dir, new Date(2026, 2, 1)));
  }
});
