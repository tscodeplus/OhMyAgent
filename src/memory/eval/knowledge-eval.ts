/**
 * Knowledge-workbench eval runner — plan §6 K0 (baseline measurement).
 *
 * Three datasets in `tests/eval/knowledge/` (JSONL, one case per line):
 *
 *   episodic.jsonl    session-recall questions, golden = `expectedMessageIds[]`
 *   semantic.jsonl    knowledge questions,      golden = `expectedMemoryIds[]` + `expectedKeywords[]`
 *   preference.jsonl  preference quizzes,       golden = `mustContain[]` + `mustNotContain[]`
 *
 * Retrieval is injected, not imported: the runner takes async
 * `retrieveMessages` / `retrieveMemories` / `retrieveKnowledge` callbacks and
 * treats each wired callback as one lane. That is what makes the same numbers
 * comparable before and after K1 (`session_search`) and K2 (knowledge pages)
 * exist — at K0 only the memory lane is wired, so the episodic number is the
 * honest 0 of "the injected block cannot contain a message id today".
 *
 * A case whose golden cannot be derived from the live database carries
 * `"unlabelled": true`. Unlabelled cases are excluded from every metric and
 * counted separately (`KnowledgeEvalRun.*.unlabelled`), because a fabricated
 * golden would turn "we cannot measure this yet" into "we failed it".
 *
 * Usage:
 *   npx tsx src/memory/eval/knowledge-eval.ts              # run, diff vs newest baseline
 *   npx tsx src/memory/eval/knowledge-eval.ts --baseline   # run, write data/eval/baseline-<date>.json
 *
 * Importing this module is side-effect free: the live database wiring and the
 * CLI both happen behind `if (import.meta.url === ...)` and use dynamic imports,
 * so unit tests can pull in the pure functions without opening SQLite, loading
 * `config.yaml` or starting the logger.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EvalPair } from './eval-builder.js';
import { computeMetrics } from './eval-runner.js';
import type { EvalMetrics, EvalResult } from './metrics.js';

// ─── Constants ───

export const KNOWLEDGE_EVAL_DATASET_DIR = 'tests/eval/knowledge';
export const BASELINE_DIR = 'data/eval';
export const DEFAULT_TOP_K = 5;
export const BASELINE_VERSION = 1;

/**
 * How much newer than the persona a preference memory may be before the
 * persona counts as stale. Persona distillation is asynchronous (it runs on the
 * `distill_threshold` of new preferences), so a preference written minutes after
 * the last distillation has not "failed" to be absorbed — it has not had a turn
 * yet. 24 h is one full day of turns: past that, the persona is genuinely
 * behind the memory layer.
 */
export const PERSONA_FRESHNESS_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/** Lane order fixes the concatenation order of the injected union. */
const LANE_ORDER: readonly EvalLane[] = ['messages', 'memories', 'knowledge'];

/**
 * Which lane is supposed to answer each dataset. K0 wires `memories` only, so
 * `episodic` scores 0 by construction; K1 wires `messages` and the number
 * becomes meaningful. `semantic` moves to `knowledge` in K2 — `keywordRecallAt5`
 * is the metric that stays comparable across that switch.
 */
const PRIMARY_LANE: Readonly<Record<'episodic' | 'semantic', EvalLane>> = {
  episodic: 'messages',
  semantic: 'memories',
};

// ─── Types ───

export type EvalLane = 'messages' | 'memories' | 'knowledge';
export type KnowledgeEvalDatasetName = 'episodic' | 'semantic' | 'preference';

/** One injected item: `id` feeds the id metrics, `text` feeds the text metrics. */
export interface RetrievalHit {
  id: string;
  text: string;
}

export type RetrieveFn = (query: string, topK: number) => Promise<RetrievalHit[]>;

export interface EpisodicEvalCase {
  id: string;
  query: string;
  /** Messages that legitimately answer the question; empty only when `unlabelled`. */
  expectedMessageIds: string[];
  unlabelled?: boolean;
  note?: string;
}

export interface SemanticEvalCase {
  id: string;
  query: string;
  expectedMemoryIds?: string[];
  /** Every keyword must appear in the top-5 injected text (after normalisation). */
  expectedKeywords: string[];
  unlabelled?: boolean;
  note?: string;
}

export interface PreferenceEvalCase {
  id: string;
  query: string;
  /** The current value; empty means "only the leakage half is measurable". */
  mustContain: string[];
  /** The superseded value(s); present ⇒ this is a changed-preference case. */
  mustNotContain: string[];
  unlabelled?: boolean;
  note?: string;
}

export interface KnowledgeEvalDataset {
  episodic: EpisodicEvalCase[];
  semantic: SemanticEvalCase[];
  preference: PreferenceEvalCase[];
}

export interface RunKnowledgeEvalOptions {
  /** Directory holding the three JSONL files. Defaults to `tests/eval/knowledge`. */
  datasetDir?: string;
  /** Top-K requested per lane. Defaults to `DEFAULT_TOP_K` (5). */
  topK?: number;
  retrieveMessages?: RetrieveFn;
  retrieveMemories?: RetrieveFn;
  retrieveKnowledge?: RetrieveFn;
  /**
   * `memories.status` reader for `inactiveLeakageCount`. Sync because every
   * caller so far is a better-sqlite3 prepared statement.
   */
  statusLookup?: (memoryId: string) => string | null | undefined;
  /** Epoch ms of the persona record, or null when there is none. */
  personaUpdatedAt?: number | null;
  /** Epoch ms of the newest active preference memory (the layer persona is distilled from). */
  newestActiveMemoryUpdatedAt?: number | null;
  logger?: (line: string) => void;
}

export interface IdRankingReport {
  labelled: number;
  unlabelled: number;
  unlabelledIds: string[];
  idRecallAt5: number;
  pAt5: number;
  rAt5: number;
  rAt10: number;
  mrr: number;
  ndcgAt5: number;
  queriesWithResults: number;
}

export interface KeywordReport {
  keywordCases: number;
  keywordRecallAt5: number;
  missedCaseIds: string[];
}

export interface PreferenceReport {
  labelled: number;
  unlabelled: number;
  unlabelledIds: string[];
  mustContainCases: number;
  mustContainRate: number;
  mustContainMissIds: string[];
  staleCases: number;
  stalePreferenceRate: number;
  leakedCaseIds: string[];
}

export interface KnowledgeEvalRun extends EvalResult {
  topK: number;
  datasetDir: string;
  /** Lanes that were wired and therefore contributed injected content. */
  lanes: EvalLane[];
  /** Lanes with no callback — their contribution to the injected union was empty. */
  unwiredLanes: EvalLane[];
  statusLookupProvided: boolean;
  episodic: IdRankingReport;
  semantic: IdRankingReport & KeywordReport;
  preference: PreferenceReport;
}

export interface KnowledgeEvalBaseline extends KnowledgeEvalRun {
  version: number;
}

interface QueryRetrieval {
  idsByLane: Partial<Record<EvalLane, string[]>>;
  unionIds: string[];
  unionText: string;
}

interface IdRankingTotals {
  scored: number;
  queriesWithResults: number;
  pAt5: number;
  rAt5: number;
  rAt10: number;
  mrr: number;
  ndcgAt5: number;
}

// ─── Pure text / metric helpers ───

const FULL_WIDTH_FIRST = 0xff01;
const FULL_WIDTH_LAST = 0xff5e;
const FULL_WIDTH_TO_ASCII = 0xfee0;
const IDEOGRAPHIC_SPACE = 0x3000;

/**
 * Lower-case, full-width → half-width, whitespace-collapsed. Keyword and
 * containment matching both go through this, so `ＥＸＣＥＬ－ＭＣＰ` and
 * `excel-mcp` are the same needle, and a `\n` inside the injected text cannot
 * hide a keyword that was written with a space.
 */
function normaliseEvalText(text: string): string {
  let halfWidth = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= FULL_WIDTH_FIRST && code <= FULL_WIDTH_LAST) {
      halfWidth += String.fromCodePoint(code - FULL_WIDTH_TO_ASCII);
    } else if (code === IDEOGRAPHIC_SPACE) {
      halfWidth += ' ';
    } else {
      halfWidth += char;
    }
  }
  return halfWidth.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Plan §6 K0 hit definition: the top-5 injected text covers ALL expected
 * keywords. Returns false for an empty keyword list — a case with no keywords
 * has nothing to cover, and `every()` on an empty array would silently report a
 * free hit.
 */
export function computeKeywordRecallAt5(injectedText: string, expectedKeywords: string[]): boolean {
  if (expectedKeywords.length === 0) return false;
  const haystack = normaliseEvalText(injectedText);
  return expectedKeywords.every((keyword) => {
    const needle = normaliseEvalText(keyword);
    return needle.length > 0 && haystack.includes(needle);
  });
}

/**
 * Nearest-rank percentiles (no interpolation) plus the arithmetic mean.
 * Nearest-rank is chosen over interpolation because it can only ever return a
 * latency that was actually observed — a p95 of 312 ms on 20 samples should be
 * a measured 312 ms, not an average of two neighbours.
 */
export function computeLatencyPercentiles(samples: number[]): {
  avg: number;
  p50: number;
  p95: number;
} {
  if (samples.length === 0) return { avg: 0, p50: 0, p95: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const avg = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return {
    avg,
    p50: nearestRank(sorted, 50),
    p95: nearestRank(sorted, 95),
  };
}

function nearestRank(sortedAscending: number[], percentile: number): number {
  const index = Math.ceil((percentile / 100) * sortedAscending.length) - 1;
  return sortedAscending[Math.min(Math.max(index, 0), sortedAscending.length - 1)];
}

function isEpochMs(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * `stale` means the preference layer has moved on and the persona has not —
 * see `PERSONA_FRESHNESS_TOLERANCE_MS` for why the comparison has a tolerance
 * instead of being `>`.
 */
export function computePersonaFreshness(
  personaUpdatedAt: number | null | undefined,
  newestActiveMemoryUpdatedAt: number | null | undefined,
): 'fresh' | 'stale' | 'unknown' {
  if (!isEpochMs(personaUpdatedAt) || !isEpochMs(newestActiveMemoryUpdatedAt)) {
    return 'unknown';
  }
  return newestActiveMemoryUpdatedAt - personaUpdatedAt > PERSONA_FRESHNESS_TOLERANCE_MS
    ? 'stale'
    : 'fresh';
}

/**
 * Injected memory ids whose status is not `'active'`. A row that no longer
 * exists (`null`/`undefined`) is NOT counted: a missing row is a provenance
 * problem, not an inactive-status leak, and conflating the two would make the
 * number drift with unrelated deletions. Duplicate injected ids count once.
 */
export function computeInactiveLeakageCount(
  injectedIds: string[],
  statusLookup: (id: string) => string | null | undefined,
): number {
  let count = 0;
  for (const id of new Set(injectedIds)) {
    const status = statusLookup(id);
    if (status !== null && status !== undefined && status !== 'active') count++;
  }
  return count;
}

function weightedMean(parts: Array<{ value: number; weight: number }>): number {
  const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
  if (totalWeight === 0) return 0;
  return parts.reduce((sum, part) => sum + part.value * part.weight, 0) / totalWeight;
}

// ─── Dataset loader ───

interface RawCase {
  entry: Record<string, unknown>;
  where: string;
}

function readJsonlCases(filePath: string): RawCase[] {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const cases: RawCase[] = [];
  raw.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('//')) return;
    const where = `${path.basename(filePath)}:${index + 1}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(
        `${where}: invalid JSON (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${where}: expected a JSON object`);
    }
    cases.push({ entry: parsed as Record<string, unknown>, where });
  });
  return cases;
}

function requireString(entry: Record<string, unknown>, field: string, where: string): string {
  const value = entry[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${where}: "${field}" must be a non-empty string`);
  }
  return value;
}

function optionalStringArray(
  entry: Record<string, unknown>,
  field: string,
  where: string,
): string[] {
  const value = entry[field];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${where}: "${field}" must be an array of strings`);
  }
  return value.map((item) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new Error(`${where}: "${field}" must contain only non-empty strings`);
    }
    return item;
  });
}

function optionalNote(entry: Record<string, unknown>, where: string): string | undefined {
  const value = entry.note;
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${where}: "note" must be a string`);
  return value;
}

function isUnlabelled(entry: Record<string, unknown>, where: string): boolean {
  const value = entry.unlabelled;
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new Error(`${where}: "unlabelled" must be a boolean`);
  return value;
}

function assertUniqueIds(cases: Array<{ id: string }>, filePath: string): void {
  const seen = new Set<string>();
  for (const evalCase of cases) {
    if (seen.has(evalCase.id)) {
      throw new Error(`${path.basename(filePath)}: duplicate case id "${evalCase.id}"`);
    }
    seen.add(evalCase.id);
  }
}

function loadEpisodic(filePath: string): EpisodicEvalCase[] {
  const cases = readJsonlCases(filePath).map(({ entry, where }) => {
    const evalCase: EpisodicEvalCase = {
      id: requireString(entry, 'id', where),
      query: requireString(entry, 'query', where),
      expectedMessageIds: optionalStringArray(entry, 'expectedMessageIds', where),
      unlabelled: isUnlabelled(entry, where) || undefined,
      note: optionalNote(entry, where),
    };
    if (!evalCase.unlabelled && evalCase.expectedMessageIds.length === 0) {
      // The trap this guards: a labelled case with no golden silently becomes a
      // guaranteed miss (or a guaranteed hit), depending on the metric.
      throw new Error(`${where}: labelled case "${evalCase.id}" needs expectedMessageIds`);
    }
    return evalCase;
  });
  assertUniqueIds(cases, filePath);
  return cases;
}

function loadSemantic(filePath: string): SemanticEvalCase[] {
  const cases = readJsonlCases(filePath).map(({ entry, where }) => {
    const evalCase: SemanticEvalCase = {
      id: requireString(entry, 'id', where),
      query: requireString(entry, 'query', where),
      expectedMemoryIds: optionalStringArray(entry, 'expectedMemoryIds', where),
      expectedKeywords: optionalStringArray(entry, 'expectedKeywords', where),
      unlabelled: isUnlabelled(entry, where) || undefined,
      note: optionalNote(entry, where),
    };
    if (
      !evalCase.unlabelled &&
      evalCase.expectedKeywords.length === 0 &&
      (evalCase.expectedMemoryIds?.length ?? 0) === 0
    ) {
      throw new Error(
        `${where}: labelled case "${evalCase.id}" needs expectedKeywords or expectedMemoryIds`,
      );
    }
    return evalCase;
  });
  assertUniqueIds(cases, filePath);
  return cases;
}

function loadPreference(filePath: string): PreferenceEvalCase[] {
  const cases = readJsonlCases(filePath).map(({ entry, where }) => {
    const evalCase: PreferenceEvalCase = {
      id: requireString(entry, 'id', where),
      query: requireString(entry, 'query', where),
      mustContain: optionalStringArray(entry, 'mustContain', where),
      mustNotContain: optionalStringArray(entry, 'mustNotContain', where),
      unlabelled: isUnlabelled(entry, where) || undefined,
      note: optionalNote(entry, where),
    };
    if (
      !evalCase.unlabelled &&
      evalCase.mustContain.length === 0 &&
      evalCase.mustNotContain.length === 0
    ) {
      throw new Error(
        `${where}: labelled case "${evalCase.id}" needs mustContain or mustNotContain`,
      );
    }
    return evalCase;
  });
  assertUniqueIds(cases, filePath);
  return cases;
}

export function loadKnowledgeEvalDataset(
  datasetDir: string = KNOWLEDGE_EVAL_DATASET_DIR,
): KnowledgeEvalDataset {
  const dir = path.resolve(datasetDir);
  return {
    episodic: loadEpisodic(path.join(dir, 'episodic.jsonl')),
    semantic: loadSemantic(path.join(dir, 'semantic.jsonl')),
    preference: loadPreference(path.join(dir, 'preference.jsonl')),
  };
}

// ─── Runner ───

function computeIdRankingTotals(
  cases: Array<{ query: string; expectedIds: string[] }>,
  idsByQuery: Map<string, string[]>,
): IdRankingTotals {
  if (cases.length === 0) {
    return {
      scored: 0,
      queriesWithResults: 0,
      pAt5: 0,
      rAt5: 0,
      rAt10: 0,
      mrr: 0,
      ndcgAt5: 0,
    };
  }
  // `computeMetrics` is sync and id-only while retrieval is async and textual,
  // so retrieval happens first and this is the thin adapter the plan asks for.
  // It compares opaque id strings; `relevantMemoryIds` is just its historical
  // field name (message ids ride through the same path for episodic cases).
  const pairs: EvalPair[] = cases.map((evalCase) => ({
    query: evalCase.query,
    candidateMemoryIds: [],
    relevantMemoryIds: evalCase.expectedIds,
  }));
  const metrics = computeMetrics(pairs, (query) => idsByQuery.get(query) ?? []);
  return {
    scored: metrics.totalQueries,
    queriesWithResults: metrics.queriesWithResults,
    pAt5: metrics.pAt5,
    rAt5: metrics.rAt5,
    rAt10: metrics.rAt10,
    mrr: metrics.mrr,
    ndcgAt5: metrics.ndcgAt5,
  };
}

function mergeIdRankingReport(
  totals: IdRankingTotals,
  unlabelledIds: string[],
  idRecallAt5: number,
): IdRankingReport {
  return {
    labelled: totals.scored,
    unlabelled: unlabelledIds.length,
    unlabelledIds,
    idRecallAt5,
    pAt5: totals.pAt5,
    rAt5: totals.rAt5,
    rAt10: totals.rAt10,
    mrr: totals.mrr,
    ndcgAt5: totals.ndcgAt5,
    queriesWithResults: totals.queriesWithResults,
  };
}

export async function runKnowledgeEval(
  options: RunKnowledgeEvalOptions,
): Promise<KnowledgeEvalRun> {
  const topK = options.topK ?? DEFAULT_TOP_K;
  const datasetDir = options.datasetDir ?? KNOWLEDGE_EVAL_DATASET_DIR;
  const dataset = loadKnowledgeEvalDataset(datasetDir);

  const laneFns: Record<EvalLane, RetrieveFn | undefined> = {
    messages: options.retrieveMessages,
    memories: options.retrieveMemories,
    knowledge: options.retrieveKnowledge,
  };
  const lanes = LANE_ORDER.filter((lane) => laneFns[lane] !== undefined);
  const unwiredLanes = LANE_ORDER.filter((lane) => laneFns[lane] === undefined);

  const retrievalByQuery = new Map<string, QueryRetrieval>();
  const latencySamples: number[] = [];
  const injectedIds = new Set<string>();

  const labelledCases: Array<{ query: string }> = [
    ...dataset.episodic.filter((c) => !c.unlabelled),
    ...dataset.semantic.filter((c) => !c.unlabelled),
    ...dataset.preference.filter((c) => !c.unlabelled),
  ];

  // Sequential on purpose: latencies are a product claim (G4), and running the
  // lanes concurrently would measure a queue, not a retrieval.
  for (const evalCase of labelledCases) {
    if (retrievalByQuery.has(evalCase.query)) continue;
    const idsByLane: Partial<Record<EvalLane, string[]>> = {};
    const unionIds: string[] = [];
    const unionTexts: string[] = [];
    const samples: number[] = [];
    for (const lane of LANE_ORDER) {
      const retrieve = laneFns[lane];
      if (!retrieve) continue;
      const started = performance.now();
      const hits = (await retrieve(evalCase.query, topK)).slice(0, topK);
      samples.push(performance.now() - started);
      idsByLane[lane] = hits.map((hit) => hit.id);
      for (const hit of hits) {
        unionIds.push(hit.id);
        unionTexts.push(hit.text);
        injectedIds.add(hit.id);
      }
    }
    retrievalByQuery.set(evalCase.query, {
      idsByLane,
      unionIds,
      unionText: unionTexts.join('\n'),
    });
    latencySamples.push(...samples);
  }

  const primaryIds = (name: 'episodic' | 'semantic'): Map<string, string[]> => {
    const lane = PRIMARY_LANE[name];
    const cases: Array<{ query: string }> =
      name === 'episodic' ? dataset.episodic : dataset.semantic;
    const map = new Map<string, string[]>();
    for (const evalCase of cases) {
      map.set(evalCase.query, retrievalByQuery.get(evalCase.query)?.idsByLane[lane] ?? []);
    }
    return map;
  };

  const hitsAnyId = (expectedIds: string[], query: string): boolean => {
    if (expectedIds.length === 0) return false;
    const retrieved = retrievalByQuery.get(query);
    if (!retrieved) return false;
    const expected = new Set(expectedIds);
    return retrieved.unionIds.some((id) => expected.has(id));
  };

  // ── episodic: session recall ──
  const episodicUnlabelledIds = dataset.episodic.filter((c) => c.unlabelled).map((c) => c.id);
  const episodicScored = dataset.episodic.filter(
    (c) => !c.unlabelled && c.expectedMessageIds.length > 0,
  );
  const episodicTotals = computeIdRankingTotals(
    episodicScored.map((c) => ({ query: c.query, expectedIds: c.expectedMessageIds })),
    primaryIds('episodic'),
  );
  const episodicIdHits = episodicScored.filter((c) =>
    hitsAnyId(c.expectedMessageIds, c.query),
  ).length;
  const episodic = mergeIdRankingReport(
    episodicTotals,
    episodicUnlabelledIds,
    episodicScored.length > 0 ? episodicIdHits / episodicScored.length : 0,
  );

  // ── semantic: knowledge questions ──
  const semanticUnlabelledIds = dataset.semantic.filter((c) => c.unlabelled).map((c) => c.id);
  const semanticIdCases = dataset.semantic.filter(
    (c) => !c.unlabelled && (c.expectedMemoryIds?.length ?? 0) > 0,
  );
  const semanticTotals = computeIdRankingTotals(
    semanticIdCases.map((c) => ({ query: c.query, expectedIds: c.expectedMemoryIds ?? [] })),
    primaryIds('semantic'),
  );
  const semanticIdHits = semanticIdCases.filter((c) =>
    hitsAnyId(c.expectedMemoryIds ?? [], c.query),
  ).length;
  const semanticKeywordCases = dataset.semantic.filter(
    (c) => !c.unlabelled && c.expectedKeywords.length > 0,
  );
  const semanticKeywordMisses: string[] = [];
  let semanticKeywordHits = 0;
  for (const evalCase of semanticKeywordCases) {
    const text = retrievalByQuery.get(evalCase.query)?.unionText ?? '';
    if (computeKeywordRecallAt5(text, evalCase.expectedKeywords)) {
      semanticKeywordHits++;
    } else {
      semanticKeywordMisses.push(evalCase.id);
    }
  }
  const semantic = {
    ...mergeIdRankingReport(
      semanticTotals,
      semanticUnlabelledIds,
      semanticIdCases.length > 0 ? semanticIdHits / semanticIdCases.length : 0,
    ),
    keywordCases: semanticKeywordCases.length,
    keywordRecallAt5:
      semanticKeywordCases.length > 0 ? semanticKeywordHits / semanticKeywordCases.length : 0,
    missedCaseIds: semanticKeywordMisses,
  };

  // ── preference: does the injected text carry the current value, and only it? ──
  const preferenceUnlabelledIds = dataset.preference.filter((c) => c.unlabelled).map((c) => c.id);
  const preferenceLabelled = dataset.preference.filter((c) => !c.unlabelled);
  let staleCases = 0;
  let staleLeaks = 0;
  let containCases = 0;
  let containHits = 0;
  const leakedCaseIds: string[] = [];
  const mustContainMissIds: string[] = [];
  for (const evalCase of preferenceLabelled) {
    const text = normaliseEvalText(retrievalByQuery.get(evalCase.query)?.unionText ?? '');
    if (evalCase.mustNotContain.length > 0) {
      staleCases++;
      const leaked = evalCase.mustNotContain.some((value) =>
        text.includes(normaliseEvalText(value)),
      );
      if (leaked) {
        staleLeaks++;
        leakedCaseIds.push(evalCase.id);
      }
    }
    if (evalCase.mustContain.length > 0) {
      containCases++;
      const satisfied = evalCase.mustContain.every((value) =>
        text.includes(normaliseEvalText(value)),
      );
      if (satisfied) containHits++;
      else mustContainMissIds.push(evalCase.id);
    }
  }
  const preference: PreferenceReport = {
    labelled: preferenceLabelled.length,
    unlabelled: preferenceUnlabelledIds.length,
    unlabelledIds: preferenceUnlabelledIds,
    mustContainCases: containCases,
    mustContainRate: containCases > 0 ? containHits / containCases : 0,
    mustContainMissIds,
    staleCases,
    stalePreferenceRate: staleCases > 0 ? staleLeaks / staleCases : 0,
    leakedCaseIds,
  };

  // ── aggregate ──
  const latency = computeLatencyPercentiles(latencySamples);
  const injectedIdList = [...injectedIds];
  const metrics: EvalMetrics = {
    pAt5: weightedMean([
      { value: episodicTotals.pAt5, weight: episodicTotals.scored },
      { value: semanticTotals.pAt5, weight: semanticTotals.scored },
    ]),
    rAt5: weightedMean([
      { value: episodicTotals.rAt5, weight: episodicTotals.scored },
      { value: semanticTotals.rAt5, weight: semanticTotals.scored },
    ]),
    rAt10: weightedMean([
      { value: episodicTotals.rAt10, weight: episodicTotals.scored },
      { value: semanticTotals.rAt10, weight: semanticTotals.scored },
    ]),
    mrr: weightedMean([
      { value: episodicTotals.mrr, weight: episodicTotals.scored },
      { value: semanticTotals.mrr, weight: semanticTotals.scored },
    ]),
    ndcgAt5: weightedMean([
      { value: episodicTotals.ndcgAt5, weight: episodicTotals.scored },
      { value: semanticTotals.ndcgAt5, weight: semanticTotals.scored },
    ]),
    totalQueries: episodicTotals.scored + semanticTotals.scored,
    queriesWithResults: episodicTotals.queriesWithResults + semanticTotals.queriesWithResults,
    keywordRecallAt5: semantic.keywordRecallAt5,
    idRecallAt5: weightedMean([
      { value: episodic.idRecallAt5, weight: episodicScored.length },
      { value: semantic.idRecallAt5, weight: semanticIdCases.length },
    ]),
    stalePreferenceRate: preference.stalePreferenceRate,
    personaFreshness: computePersonaFreshness(
      options.personaUpdatedAt,
      options.newestActiveMemoryUpdatedAt,
    ),
    inactiveLeakageCount: options.statusLookup
      ? computeInactiveLeakageCount(injectedIdList, options.statusLookup)
      : 0,
    averageRetrievalLatencyMs: latency.avg,
    latencyP50Ms: latency.p50,
    latencyP95Ms: latency.p95,
  };

  const run: KnowledgeEvalRun = {
    timestamp: new Date().toISOString(),
    summary: '',
    topK,
    datasetDir,
    lanes: [...lanes],
    unwiredLanes: [...unwiredLanes],
    statusLookupProvided: options.statusLookup !== undefined,
    metrics,
    episodic,
    semantic,
    preference,
  };
  run.summary = formatKnowledgeEvalReport(run);

  options.logger?.(run.summary);
  if (options.logger) {
    for (const line of formatDatasetDetail(run)) options.logger(line);
  }

  return run;
}

// ─── Report formatting ───

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatMs(value: number): string {
  return `${value.toFixed(1)}ms`;
}

function formatDatasetDetail(run: KnowledgeEvalRun): string[] {
  const lines: string[] = [];
  const unlabelledNotes = (ids: string[]): string =>
    ids.length === 0 ? '' : `  (unlabelled: ${ids.join(', ')})`;
  lines.push(
    `episodic:   ${run.episodic.labelled} labelled, ${run.episodic.unlabelled} unlabelled${unlabelledNotes(run.episodic.unlabelledIds)}`,
  );
  lines.push(
    `semantic:   ${run.semantic.labelled} labelled, ${run.semantic.unlabelled} unlabelled${unlabelledNotes(run.semantic.unlabelledIds)}`,
  );
  lines.push(
    `preference: ${run.preference.labelled} labelled, ${run.preference.unlabelled} unlabelled${unlabelledNotes(run.preference.unlabelledIds)}` +
      `, ${run.preference.staleCases} changed-preference case(s)`,
  );
  if (run.preference.mustContainMissIds.length > 0) {
    lines.push(`  mustContain misses: ${run.preference.mustContainMissIds.join(', ')}`);
  }
  if (run.preference.leakedCaseIds.length > 0) {
    lines.push(`  stale leaks: ${run.preference.leakedCaseIds.join(', ')}`);
  }
  if (run.semantic.missedCaseIds.length > 0) {
    lines.push(`  keyword misses: ${run.semantic.missedCaseIds.join(', ')}`);
  }
  return lines;
}

export function formatKnowledgeEvalReport(run: KnowledgeEvalRun): string {
  const metrics = run.metrics;
  return [
    '=== Knowledge Eval (K0 baseline) ===',
    `dataset: ${run.datasetDir}  topK: ${run.topK}`,
    `lanes wired: ${run.lanes.length > 0 ? run.lanes.join(', ') : '(none)'}` +
      (run.unwiredLanes.length > 0 ? `  |  not wired: ${run.unwiredLanes.join(', ')}` : ''),
    `id metrics over ${metrics.totalQueries} id-labelled case(s)` +
      ` (${metrics.queriesWithResults} returned a candidate)`,
    `  idRecall@5: ${formatPercent(metrics.idRecallAt5)}   keywordRecall@5: ${formatPercent(metrics.keywordRecallAt5)}`,
    `  P@5: ${formatPercent(metrics.pAt5)}   R@5: ${formatPercent(metrics.rAt5)}   R@10: ${formatPercent(metrics.rAt10)}` +
      `   MRR: ${metrics.mrr.toFixed(4)}   NDCG@5: ${metrics.ndcgAt5.toFixed(4)}`,
    `  stalePreferenceRate: ${formatPercent(metrics.stalePreferenceRate)}` +
      `   inactiveLeakageCount: ${metrics.inactiveLeakageCount}` +
      (run.statusLookupProvided ? '' : ' (no status lookup wired)'),
    `  personaFreshness: ${metrics.personaFreshness}`,
    `  latency: avg ${formatMs(metrics.averageRetrievalLatencyMs)}` +
      `   p50 ${formatMs(metrics.latencyP50Ms)}   p95 ${formatMs(metrics.latencyP95Ms)}`,
  ].join('\n');
}

// ─── Baseline files ───

type NumericEvalMetricKey = Exclude<keyof EvalMetrics, 'personaFreshness'>;

interface MetricRow {
  key: NumericEvalMetricKey;
  label: string;
  unit: 'rate' | 'decimal' | 'ms' | 'count';
}

const METRIC_ROWS: readonly MetricRow[] = [
  { key: 'idRecallAt5', label: 'idRecall@5', unit: 'rate' },
  { key: 'keywordRecallAt5', label: 'keywordRecall@5', unit: 'rate' },
  { key: 'pAt5', label: 'P@5', unit: 'rate' },
  { key: 'rAt5', label: 'R@5', unit: 'rate' },
  { key: 'rAt10', label: 'R@10', unit: 'rate' },
  { key: 'mrr', label: 'MRR', unit: 'decimal' },
  { key: 'ndcgAt5', label: 'NDCG@5', unit: 'decimal' },
  { key: 'stalePreferenceRate', label: 'stalePreferenceRate', unit: 'rate' },
  { key: 'inactiveLeakageCount', label: 'inactiveLeakageCount', unit: 'count' },
  { key: 'averageRetrievalLatencyMs', label: 'latency avg', unit: 'ms' },
  { key: 'latencyP50Ms', label: 'latency p50', unit: 'ms' },
  { key: 'latencyP95Ms', label: 'latency p95', unit: 'ms' },
  { key: 'totalQueries', label: 'totalQueries', unit: 'count' },
  { key: 'queriesWithResults', label: 'queriesWithResults', unit: 'count' },
];

function formatMetricValue(value: number, unit: MetricRow['unit']): string {
  switch (unit) {
    case 'rate':
      return formatPercent(value);
    case 'decimal':
      return value.toFixed(4);
    case 'ms':
      return formatMs(value);
    case 'count':
      return String(value);
  }
}

function formatMetricDelta(current: number, baseline: number, unit: MetricRow['unit']): string {
  if (current === baseline) return '0';
  const delta = current - baseline;
  const sign = delta > 0 ? '+' : '';
  switch (unit) {
    case 'rate':
      return `${sign}${(delta * 100).toFixed(1)}pp`;
    case 'decimal':
      return `${sign}${delta.toFixed(4)}`;
    case 'ms':
      return `${sign}${delta.toFixed(1)}ms`;
    case 'count':
      return `${sign}${delta}`;
  }
}

/** Local `YYYY-MM-DD` (not UTC — a baseline is dated by the operator's day). */
function baselineDateStamp(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function writeBaseline(
  run: KnowledgeEvalRun,
  dir: string = BASELINE_DIR,
  now: Date = new Date(),
): string {
  const resolvedDir = path.resolve(dir);
  fs.mkdirSync(resolvedDir, { recursive: true });
  const filePath = path.join(resolvedDir, `baseline-${baselineDateStamp(now)}.json`);
  const baseline: KnowledgeEvalBaseline = { version: BASELINE_VERSION, ...run };
  fs.writeFileSync(filePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf-8');
  return filePath;
}

/** Newest baseline by filename — the date stamp sorts lexicographically. */
export function findLatestBaseline(dir: string = BASELINE_DIR): string | null {
  const resolvedDir = path.resolve(dir);
  if (!fs.existsSync(resolvedDir)) return null;
  const files = fs
    .readdirSync(resolvedDir)
    .filter((name) => /^baseline-\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort();
  return files.length === 0 ? null : path.join(resolvedDir, files[files.length - 1]);
}

export function loadBaseline(filePath: string): KnowledgeEvalBaseline {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as KnowledgeEvalBaseline;
}

export function formatBaselineDiff(current: EvalMetrics, baseline: KnowledgeEvalBaseline): string {
  const lines = [
    `=== Diff vs baseline (${baseline.timestamp}) ===`,
    `baseline lanes: ${baseline.lanes.join(', ') || '(none)'}`,
    `${'metric'.padEnd(24)}${'baseline'.padStart(12)}${'current'.padStart(12)}${'delta'.padStart(12)}`,
  ];
  for (const row of METRIC_ROWS) {
    const before = baseline.metrics[row.key];
    const after = current[row.key];
    lines.push(
      `${row.label.padEnd(24)}${formatMetricValue(before, row.unit).padStart(12)}` +
        `${formatMetricValue(after, row.unit).padStart(12)}` +
        `${formatMetricDelta(after, before, row.unit).padStart(12)}`,
    );
  }
  lines.push(
    `${'personaFreshness'.padEnd(24)}${baseline.metrics.personaFreshness.padStart(12)}` +
      `${current.personaFreshness.padStart(12)}`,
  );
  return lines.join('\n');
}

// ─── CLI ───

interface CliOptions {
  baseline: boolean;
  help: boolean;
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = { baseline: false, help: false };
  for (const arg of argv) {
    if (arg === '--baseline') options.baseline = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown option: ${arg} (try --help)`);
  }
  return options;
}

const CLI_HELP = `Usage: tsx src/memory/eval/knowledge-eval.ts [--baseline]

  (no flag)   run the three datasets and diff the metrics against the newest
              ${BASELINE_DIR}/baseline-<date>.json
  --baseline  run and archive the report as ${BASELINE_DIR}/baseline-<date>.json
  --help      this text

The run measures the lane that the app actually injects today (auto-recall over
\`memories\`). Message retrieval (K1) and knowledge pages (K2) have no
implementation yet, so those lanes are reported as "not wired" and contribute
nothing to the injected union — the episodic number is therefore the honest
baseline of the current stack, not a skipped measurement.
`;

interface LiveEvalContext {
  databasePath: string;
  options: RunKnowledgeEvalOptions;
  close: () => void;
}

/**
 * Wires the memory lane exactly the way `bootstrap()` does
 * (`src/app/composers/memory-services.ts`): same retriever, same config values.
 * Loaded through dynamic imports so importing this module in a test does not
 * open `config.yaml`, SQLite or pino.
 */
async function createLiveEvalContext(): Promise<LiveEvalContext> {
  await import('dotenv/config');
  const [
    { loadConfig },
    { openDatabase },
    { MemoryRepository },
    { EmbeddingRepository },
    { EmbeddingCacheRepo },
    { MemoryRetriever },
    { MemoryLinkRepository },
    { CircuitBreaker },
    { createEmbeddingClient },
    { parseEpochMs },
  ] = await Promise.all([
    import('../../app/config.js'),
    import('../db.js'),
    import('../repositories/memory-repository.js'),
    import('../repositories/embedding-repository.js'),
    import('../repositories/embedding-cache-repository.js'),
    import('../memory-retriever.js'),
    import('../repositories/memory-link-repository.js'),
    import('../circuit-breaker.js'),
    import('../../provider/embedding-client.js'),
    import('../../shared/timestamp.js'),
  ]);

  const config = loadConfig();
  const databasePath = config.database.path;
  // Read-write because `openDatabase()` runs the idempotent migrations that
  // every other CLI (`graph:sync`, `memory:doctor`) also relies on. The eval
  // itself only reads.
  const db = openDatabase(databasePath);

  const cbConfig = config.memory.embeddingCircuitBreaker;
  const embeddingBreaker = new CircuitBreaker({
    failureThreshold: cbConfig.failureThreshold,
    cooldownMs: cbConfig.cooldownSec * 1000,
  });
  const embeddingClient = createEmbeddingClient({ embedding: config.embedding }, embeddingBreaker);
  const embeddingRepository = new EmbeddingRepository(db);
  const retriever = new MemoryRetriever({
    memoryRepository: new MemoryRepository(db),
    embeddingRepository,
    embeddingClient,
    embeddingCacheRepo: new EmbeddingCacheRepo(db, 10_000),
    db,
    embeddingBreaker,
    decayConfig: { halfLifeDays: config.memory.decayHalfLifeDays },
    defaultMinScore: config.memory.recallMinScore,
    memoryLinkRepo: new MemoryLinkRepository(db),
    queryEmbeddingTimeoutMs: config.memory.queryEmbeddingTimeoutMs,
    plannerConfig: {
      enabled: config.memory.queryPlanner.enabled,
      commonalityCoverage: config.memory.queryPlanner.commonalityCoverage,
      speakerBoost: config.memory.queryPlanner.speakerBoost,
      perSlotFloor: config.memory.queryPlanner.perSlotFloor,
      maxEntities: config.memory.queryPlanner.maxEntities,
      llm: { enabled: config.memory.queryPlanner.llm.enabled },
    },
    recallConfig: {
      prefilterMultiplier: config.memory.recall.prefilterMultiplier,
      prefilterMin: config.memory.recall.prefilterMin,
      mergeCandidateMultiplier: config.memory.recall.mergeCandidateMultiplier,
      maxCharsPerMemory: config.memory.recall.maxCharsPerMemory,
      maxTotalRecallChars: config.memory.recall.maxTotalRecallChars,
    },
    searchConcurrency: config.performance?.embeddingApiConcurrency ?? 8,
  });

  const statusStatement = db.prepare('SELECT status FROM memories WHERE id = ?');
  // Rows that live in `memories` but are not retrievable knowledge: the persona
  // blob (injected separately as `<persona>`, so counting it here both double
  // counts a block that is not a retrieval result and saturates keywordRecall@5
  // — it mentions nearly every preference) and the hygiene checkpoint (a bare
  // epoch-ms marker). Measured once: without this filter the persona JSON was a
  // top-5 hit for 1 of 3 sampled queries.
  const alwaysOnRows = db
    .prepare("SELECT id FROM memories WHERE kind IN ('persona', 'hygiene_checkpoint')")
    .all() as Array<{ id: string }>;
  const alwaysOnIds = new Set(alwaysOnRows.map((row) => row.id));
  const personaRow = db
    .prepare(
      "SELECT updated_at FROM memories WHERE kind = 'persona' ORDER BY updated_at DESC LIMIT 1",
    )
    .get() as { updated_at?: unknown } | undefined;
  const newestPreferenceRow = db
    .prepare(
      "SELECT MAX(updated_at) AS updated_at FROM memories WHERE kind = 'preference' AND status = 'active'",
    )
    .get() as { updated_at?: unknown } | undefined;

  return {
    databasePath,
    options: {
      retrieveMemories: async (query, topK) => {
        const memories = await retriever.retrieveGrouped({ query, agentId: 'default', topK });
        return memories
          .filter((memory) => !alwaysOnIds.has(memory.id))
          .map((memory) => ({ id: memory.id, text: memory.content }));
      },
      statusLookup: (memoryId) => {
        const row = statusStatement.get(memoryId) as { status?: string } | undefined;
        return row?.status ?? null;
      },
      personaUpdatedAt: parseEpochMs(personaRow?.updated_at),
      newestActiveMemoryUpdatedAt: parseEpochMs(newestPreferenceRow?.updated_at),
    },
    close: () => db.close(),
  };
}

async function runKnowledgeEvalCli(argv: string[]): Promise<number> {
  const options = parseCliArgs(argv);
  if (options.help) {
    console.log(CLI_HELP);
    return 0;
  }

  const live = await createLiveEvalContext();
  try {
    console.log(`database: ${live.databasePath}`);
    console.log(
      'memory lane: auto-recall retrieveGrouped(topK=5), persona/hygiene rows excluded (always-on context)',
    );
    const run = await runKnowledgeEval({
      ...live.options,
      datasetDir: KNOWLEDGE_EVAL_DATASET_DIR,
      logger: (line) => console.log(line),
    });

    if (options.baseline) {
      const filePath = writeBaseline(run);
      console.log('');
      console.log(`baseline written: ${filePath}`);
      return 0;
    }

    const latest = findLatestBaseline();
    console.log('');
    if (!latest) {
      console.log(`no baseline in ${BASELINE_DIR}/ — run once with --baseline to create one`);
      return 0;
    }
    console.log(formatBaselineDiff(run.metrics, loadBaseline(latest)));
    return 0;
  } finally {
    live.close();
  }
}

// Only run when invoked as a script. `pathToFileURL` rather than
// `file://${process.argv[1]}` because the latter compares "file://E:/…" on
// Windows against import.meta.url's "file:///E:/…" and silently never matches.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  runKnowledgeEvalCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err instanceof Error ? err.stack : String(err));
      process.exitCode = 1;
    },
  );
}
