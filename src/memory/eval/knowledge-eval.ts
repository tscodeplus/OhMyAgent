/**
 * Knowledge-workbench eval runner — plan §6 K0, measuring the stack that ships.
 *
 * Four datasets in `tests/eval/knowledge/` (JSONL, one case per line):
 *
 *   episodic.jsonl    session-recall questions, golden = `expectedMessageIds[]`
 *   semantic.jsonl    knowledge questions,      golden = `expectedMemoryIds[]` + `expectedKeywords[]`
 *   preference.jsonl  preference quizzes,       golden = `mustContain[]` + `mustNotContain[]`
 *   graph.jsonl       relation questions,       golden = `expectedNeighbours[]` + `forbiddenNeighbours[]`
 *
 * The graph dataset is the one lane whose answer is not fused: `memory_recall`
 * appends `A —REL→ B [mem:x]` hints to its own tool result, so the hints are
 * measured against what the hint block presented (`hintsFor`, wired to
 * `readHintsForMemories`), not against the fused hit list. Everything else —
 * corpus applicability, unlabelled cases, the honest-reporting rules — behaves
 * the same, and the numbers are reported beside the fused metrics instead of
 * being averaged into them: a hint layer cannot raise a memory's rank
 * (`neighborhood.ts`), so a fused number that included it would describe a
 * ranking the agent does not have.
 *
 * ## What is measured
 *
 * Retrieval is injected, not imported: the runner takes ONE async `search`
 * callback whose result is "what `unifiedSearch()` returned" — an ordered fused
 * hit list, each hit tagged with the lane that produced it, plus the per-lane
 * run reports. Measuring the fused list instead of each lane separately is the
 * whole point: the previous K0 harness scored the memory lane alone
 * (`MemoryRetriever.retrieveGrouped`), which stopped being what the agent
 * injects once K1 (`session_search` over `messages_fts_jieba`), K2 (knowledge
 * pages) and K5 (`unifiedSearch()`) shipped. A number that describes a lane the
 * agent no longer uses alone is not a regression signal; it is a fossil.
 *
 * Per-lane attribution is kept (`KnowledgeEvalRun.byLane`,
 * `KnowledgeEvalRun.cases`), so a regression can be blamed on one lane instead
 * of on "the eval": every hit in the measured top-K remembers which lane put it
 * there, and each lane gets its own id-recall and precision over the same
 * id-labelled cases.
 *
 * ## What is not scored
 *
 * A dataset's goldens are quoted from one corpus (`manifest.json` says which:
 * the shipped three say `dev-machine`). On any other corpus the keyword and id
 * expectations cannot match, so a `0.0%` there does not mean "retrieval
 * failed" — it means "wrong corpus", which is the worst kind of gate: it reads
 * as a failure and is unfalsifiable. So a dataset that is not applicable
 * reports `not applicable` (`null` in the JSON, `n/a` in the report) together
 * with the reason, and the aggregate metrics skip it instead of averaging a
 * zero into them. `portable: true` in the manifest is the opposite declaration:
 * expectations that hold on any corpus, with id goldens scored only for the ids
 * that exist in the corpus actually measured (`idExists`).
 *
 * A case whose golden cannot be derived from the live database carries
 * `"unlabelled": true`. Unlabelled cases are excluded from every metric and
 * counted separately (`KnowledgeEvalRun.*.unlabelled`), because a fabricated
 * golden would turn "we cannot measure this yet" into "we failed it".
 *
 * ## Metric definitions (harness v2)
 *
 * `HARNESS_VERSION` is 2. It exists because v1 scored each dataset on its
 * *primary lane's* top-5 (memories for `semantic`, messages for `episodic`) while
 * v2 scores the **fused** top-K that `unifiedSearch()` returns — the list the
 * agent actually injects. Same field names, different measurement, therefore
 * incomparable numbers: `formatBaselineDiff()` refuses to diff across a
 * `harnessVersion`, lane-set or corpus change instead of printing a delta.
 *
 * The search is called at `max(topK, RANKING_DEPTH)` so that `rAt10` is a real
 * depth-10 recall; `topK` (default 5) still bounds every "injected" metric
 * (`idRecallAt5`, `keywordRecallAt5`, `P@5`, `R@5`, `NDCG@5`, `MRR`, and the
 * per-lane numbers), which is the plan's defined hit: the top-5 injected union.
 *
 * Usage:
 *   npx tsx src/memory/eval/knowledge-eval.ts --corpus dev-machine
 *   npx tsx src/memory/eval/knowledge-eval.ts --corpus dev-machine --baseline
 *
 * Importing this module is side-effect free: the live database wiring and the
 * CLI both happen behind `if (import.meta.url === ...)` and use dynamic imports,
 * so unit tests can pull in the pure functions without opening SQLite, loading
 * `config.yaml` or starting the logger.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GraphHint } from '../../graph/neighborhood.js';
import type { EvalPair } from './eval-builder.js';
import { computeMetrics } from './eval-runner.js';
import type { EvalMetrics, EvalResult } from './metrics.js';

// ─── Constants ───

export const KNOWLEDGE_EVAL_DATASET_DIR = 'tests/eval/knowledge';
/** Corpus declaration for a dataset directory — see `KnowledgeEvalManifest`. */
export const KNOWLEDGE_EVAL_MANIFEST_FILE = 'manifest.json';
export const BASELINE_DIR = 'data/eval';
export const DEFAULT_TOP_K = 5;
/**
 * Depth the search is called at, so `rAt10` measures ten results instead of
 * aliasing `rAt5` (the K0 harness asked each lane for exactly `topK` and then
 * reported the same number twice under two names).
 */
export const RANKING_DEPTH = 10;
/** Shape of `data/eval/baseline-<date>.json`. Bumped when that JSON changes. */
export const BASELINE_FILE_VERSION = 2;
/**
 * The harness's identity, not the file's. Bumped whenever a metric's definition
 * changes: a number from another harness is not a comparable number, and
 * `formatBaselineDiff()` is the gate that says so.
 *
 *   1 — K0: each dataset scored on its primary lane's top-5 (memory lane only
 *       from the shipped wiring), `rAt10` aliasing `rAt5`.
 *   2 — fused three-lane top-K through `unifiedSearch()`, per-lane attribution,
 *       corpus-scoped applicability, `rAt10` measured at depth 10.
 */
export const HARNESS_VERSION = 2;
export const KNOWLEDGE_EVAL_MANIFEST_VERSION = 1;

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

const DATASET_ORDER: readonly KnowledgeEvalDatasetName[] = [
  'episodic',
  'semantic',
  'preference',
  'graph',
];

// ─── Types ───

export type EvalLane = 'messages' | 'memories' | 'knowledge';
export type KnowledgeEvalDatasetName = 'episodic' | 'semantic' | 'preference' | 'graph';

/** One injected item: `id` feeds the id metrics, `text` feeds the text metrics. */
export interface EvalSearchHit {
  /** Which lane produced this hit — the per-lane attribution's only input. */
  lane: EvalLane;
  /** Lane-native id: message id, memory id, or knowledge page id. */
  id: string;
  text: string;
}

/** What one lane did for one query; absent lane = not wired for this run. */
export interface EvalLaneRun {
  hits: number;
  /** Rows the fusion dropped because a page already covers their source. */
  dropped?: number;
  /** Set when the lane failed; the other lanes still answered. */
  error?: string;
}

/**
 * The measured object: the fused list `unifiedSearch()` returns, plus the
 * per-lane report it already computes.
 *
 * It is a narrowed copy of `UnifiedSearchResult` on purpose — `lane`/`ref`/
 * `snippet` mapped to `lane`/`id`/`text` — so this module can be tested without
 * a database, and so the eval cannot start depending on fields it does not use.
 */
export interface EvalSearchResult {
  /** Fused, best-first. Each hit names the lane that produced it. */
  hits: EvalSearchHit[];
  /** One entry per lane that actually ran; a missing key means "not wired". */
  lanes: Partial<Record<EvalLane, EvalLaneRun>>;
}

export type EvalSearchFn = (query: string, topK: number) => Promise<EvalSearchResult>;

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

/** One relation a graph case needs the hint block to present. */
export interface GraphNeighbourExpectation {
  subject: string;
  relation: string;
  object: string;
}

/**
 * A pair the corpus only co-mentions. Presenting it with any relation turns
 * co-occurrence into a statement, which is the failure `MENTIONED` is kept out
 * of `entity_edges` to prevent (docs/KNOWLEDGE_GRAPH.md §3).
 */
export interface GraphMentionPair {
  subject: string;
  object: string;
}

export interface GraphEvalCase {
  id: string;
  query: string;
  /**
   * Memories whose hints answer this question. When empty the case is seeded
   * from the query's own memory hits, exactly as `memory_recall` does; a case
   * that pins them measures the graph rather than the retrieval that the
   * semantic dataset already scores.
   */
  seedMemoryIds: string[];
  /** Every one of these must be presented, or the case is a miss. */
  expectedNeighbours: GraphNeighbourExpectation[];
  /** None of these pairs may be presented with any relation. */
  forbiddenNeighbours: GraphMentionPair[];
  unlabelled?: boolean;
  note?: string;
}

/**
 * Which corpus one dataset file's goldens were written against.
 *
 * Exactly one of the two fields is required, and that requirement is what stops
 * a dataset from silently claiming to work everywhere:
 *
 * - `corpus: '<label>'` — the goldens are quoted rows of that one corpus. On a
 *   run that does not declare the same corpus the dataset reports
 *   `not applicable` rather than `0%`.
 * - `portable: true` — the expectations hold on any corpus (a shape claim like
 *   "the top hit is one of these message ids"), so the dataset scores anywhere;
 *   id goldens that do not exist in the measured corpus are counted as
 *   unresolvable and excluded per case, never as misses.
 */
export interface DatasetCorpusDeclaration {
  corpus?: string;
  portable?: boolean;
  note?: string;
}

export interface KnowledgeEvalManifest {
  version: number;
  datasets: Record<KnowledgeEvalDatasetName, DatasetCorpusDeclaration>;
}

export interface KnowledgeEvalDataset {
  manifest: KnowledgeEvalManifest;
  episodic: EpisodicEvalCase[];
  semantic: SemanticEvalCase[];
  preference: PreferenceEvalCase[];
  graph: GraphEvalCase[];
}

export interface RunKnowledgeEvalOptions {
  /** The fused search under measure (`unifiedSearch()` in the CLI). */
  search: EvalSearchFn;
  /** Directory holding the three JSONL files. Defaults to `tests/eval/knowledge`. */
  datasetDir?: string;
  /** Top-K of the fused list that the "injected" metrics score. Defaults to 5. */
  topK?: number;
  /**
   * Which corpus this run measures (`--corpus <label>`). `null`/omitted means
   * undeclared — a corpus-specific dataset then reports `not applicable`,
   * because guessing that the run is on the right corpus is the assumption this
   * whole distinction exists to remove.
   */
  corpus?: string | null;
  /**
   * Whether a golden id exists in the measured corpus. Only consulted for
   * portable datasets (see `DatasetCorpusDeclaration`); absent means the caller
   * cannot resolve ids, so a portable dataset's id goldens are scored as-is.
   */
  idExists?: (id: string) => boolean;
  /**
   * `memories.status` reader for `inactiveLeakageCount`. Sync because every
   * caller so far is a better-sqlite3 prepared statement.
   */
  statusLookup?: (memoryId: string) => string | null | undefined;
  /** Epoch ms of the persona record, or null when there is none. */
  personaUpdatedAt?: number | null;
  /** Epoch ms of the newest active preference memory (the layer persona is distilled from). */
  newestActiveMemoryUpdatedAt?: number | null;
  /**
   * The graph hint block for a set of memories — `readHintsForMemories(db, ids)`
   * in the CLI, a stub in tests. Absent means the graph lane is not wired, and
   * `graph.applicable` says so instead of reporting 0%.
   */
  hintsFor?: (memoryIds: string[]) => GraphHint[];
  logger?: (line: string) => void;
}

export interface IdRankingReport {
  /** False when the dataset's corpus expectations do not hold here — then every metric is null. */
  applicable: boolean;
  /** Why it is or is not applicable — populated either way. */
  applicabilityReason: string;
  labelled: number;
  unlabelled: number;
  unlabelledIds: string[];
  /** Labelled cases excluded from scoring because their golden ids do not exist in this corpus (portable datasets only). */
  unresolvable: number;
  unresolvableIds: string[];
  idRecallAt5: number | null;
  pAt5: number | null;
  rAt5: number | null;
  rAt10: number | null;
  mrr: number | null;
  ndcgAt5: number | null;
  queriesWithResults: number;
}

export interface KeywordReport {
  keywordCases: number;
  keywordRecallAt5: number | null;
  missedCaseIds: string[];
}

export interface PreferenceReport {
  applicable: boolean;
  applicabilityReason: string;
  labelled: number;
  unlabelled: number;
  unlabelledIds: string[];
  unresolvable: number;
  unresolvableIds: string[];
  mustContainCases: number;
  mustContainRate: number | null;
  mustContainMissIds: string[];
  staleCases: number;
  stalePreferenceRate: number | null;
  leakedCaseIds: string[];
}

/**
 * The graph lane: does the hint block present the relations the question needs,
 * and only those?
 *
 * Direction is deliberately not asserted. No gate reads word order
 * (docs/KNOWLEDGE_GRAPH.md §2), so `A —USES→ B` and `B —USES→ A` both pass
 * attestation; scoring the arrow would fail a corpus for a defect the eval
 * cannot see, and the lane's job is to report whether the relation is presented
 * at all. `forbiddenNeighbours` is the half that catches co-occurrence dressed
 * as a statement — a graph with the wrong edges still answers every expected
 * neighbour, so `neighbourRecall` alone cannot see that failure.
 */
export interface GraphReport {
  applicable: boolean;
  applicabilityReason: string;
  labelled: number;
  unlabelled: number;
  unlabelledIds: string[];
  /** Cases where every expected neighbour was presented. */
  casesWithAllNeighbours: number;
  /** Expected triples across scored cases. */
  neighbourAssertions: number;
  neighboursPresented: number;
  neighbourRecall: number | null;
  /** Cases whose expected neighbours were not all presented. */
  missedCaseIds: string[];
  negativeCases: number;
  negativeCasesClean: number;
  negativePassRate: number | null;
  /** Cases that presented a mention-only pair as a relation. */
  mentionOnlyLeakIds: string[];
  /** Hints the block presented across scored cases — 0 with an empty graph. */
  hintsPresented: number;
  /** Set when the hints provider threw; the lane then measured nothing. */
  providerError?: string;
}

/** Per-lane blame surface: one row per lane, over the same cases as the aggregate. */
export interface LaneAttribution {
  lane: EvalLane;
  /** Hits this lane put into the measured top-K across every query the run issued. */
  hits: number;
  /** Queries where the lane put at least one hit into the measured top-K. */
  queriesWithHits: number;
  /** Id-labelled cases scored for this lane's recall/precision (0 when no id dataset is applicable). */
  idCases: number;
  /** Of `idCases`, how many got at least one expected id from this lane. */
  idCasesWithHit: number;
  /** Macro mean over `idCases` of `|expected ∩ lane hits| / |expected|`; null when nothing was scored. */
  idRecallAt5: number | null;
  /** `Σ relevant lane hits / Σ lane hits` over `idCases`; null when the lane contributed nothing there. */
  precisionAt5: number | null;
}

/** Which lane produced each hit of one case, so a miss has an owner. */
export interface EvalCaseAttribution {
  dataset: KnowledgeEvalDatasetName;
  id: string;
  query: string;
  /** False ⇒ the dataset was not applicable here (or the goldens are absent); the case was not scored. */
  scored: boolean;
  /** Why the case was not scored — always set when `scored` is false. */
  skippedReason?: string;
  /** The measured top-K, best first, tagged with the lane that produced each hit. */
  hits: Array<{ lane: EvalLane; id: string }>;
  /** Expected ids the measured top-K contains, with the lane that supplied them. */
  matchedIds: Array<{ lane: EvalLane; id: string }>;
}

export interface KnowledgeEvalRun extends EvalResult {
  harnessVersion: number;
  topK: number;
  /** Corpus this run declared it measures; null = undeclared. */
  corpus: string | null;
  datasetDir: string;
  /** Lanes that actually ran — what the numbers came from. */
  lanes: EvalLane[];
  /** Lanes that never ran; printed explicitly so silence cannot read as success. */
  unwiredLanes: EvalLane[];
  /** Lanes that put at least one hit into a measured top-K. */
  lanesWithHits: EvalLane[];
  /** Per-lane failures seen while measuring — a lane that threw still has a name. */
  laneErrors: Array<{ lane: EvalLane; message: string }>;
  /** Per-dataset corpus fit, with the reason. */
  datasetApplicability: DatasetApplicability[];
  statusLookupProvided: boolean;
  byLane: LaneAttribution[];
  cases: EvalCaseAttribution[];
  episodic: IdRankingReport;
  semantic: IdRankingReport & KeywordReport;
  preference: PreferenceReport;
  /**
   * The graph lane, reported beside the fused metrics rather than inside them
   * — see this module's header. A baseline file carries it too, so a later
   * baseline has the number even though `formatBaselineDiff` does not tabulate
   * it: a hint layer does not move any fused metric, so a delta row would be a
   * row of zeros pretending to be a measurement.
   */
  graph: GraphReport;
}

export interface DatasetApplicability {
  dataset: KnowledgeEvalDatasetName;
  /** `null` for a portable dataset. */
  corpusExpectation: string | null;
  portable: boolean;
  applicable: boolean;
  reason: string;
}

export interface KnowledgeEvalBaseline extends KnowledgeEvalRun {
  /** Baseline file shape (`BASELINE_FILE_VERSION`). */
  version: number;
}

interface QueryRetrieval {
  /** Fused order, up to `RANKING_DEPTH`. */
  hits: EvalSearchHit[];
  /** Measured top-K: what the "injected" metrics score. */
  topHits: EvalSearchHit[];
  text: string;
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

export interface CorpusFit {
  applicable: boolean;
  /** Human explanation — set whichever way the check went. */
  reason: string;
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

/**
 * The aggregate over datasets that were actually scored.
 *
 * A not-applicable dataset drops out instead of contributing a zero: that
 * substitution is the whole point of the corpus distinction. When nothing was
 * scored the aggregate is `null`, not `0` — an unfalsifiable zero is what the
 * old single-lane harness printed on every foreign corpus.
 */
function aggregateMetric(parts: Array<{ value: number | null; weight: number }>): number | null {
  const usable = parts.filter(
    (part): part is { value: number; weight: number } => part.value !== null && part.weight > 0,
  );
  return usable.length === 0 ? null : weightedMean(usable);
}

// ─── Corpus applicability ───

function normaliseCorpusLabel(label: string | null | undefined): string | null {
  if (typeof label !== 'string') return null;
  const trimmed = label.trim().toLowerCase();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Does this dataset's goldens belong to the corpus this run measures?
 *
 * Order matters: `portable` first (so it never needs a corpus), then the
 * undeclared-run case (reported separately from a mismatch, because the fix is
 * `--corpus <label>` rather than a different dataset), then the comparison.
 * Every branch returns a sentence, including the applicable one — a fit line
 * that only appears when it fails teaches operators to read silence as success.
 */
export function computeCorpusFit(
  declaration: DatasetCorpusDeclaration,
  runCorpus: string | null | undefined,
): CorpusFit {
  if (declaration.portable === true) {
    return {
      applicable: true,
      reason: 'portable dataset — its expectations hold on any corpus',
    };
  }
  const expected = normaliseCorpusLabel(declaration.corpus);
  const actual = normaliseCorpusLabel(runCorpus);
  if (expected === null) {
    return {
      applicable: false,
      reason: `dataset declares no corpus in ${KNOWLEDGE_EVAL_MANIFEST_FILE} — cannot tell whether its goldens belong to this corpus`,
    };
  }
  if (actual === null) {
    return {
      applicable: false,
      reason: `this run declares no corpus (pass --corpus <label>); the dataset expects '${expected}'`,
    };
  }
  if (actual !== expected) {
    return {
      applicable: false,
      reason: `dataset written for corpus '${expected}', this run measures '${actual}'`,
    };
  }
  return { applicable: true, reason: `corpus '${expected}' matches the dataset` };
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

function loadGraph(filePath: string): GraphEvalCase[] {
  const cases = readJsonlCases(filePath).map(({ entry, where }) => {
    const evalCase: GraphEvalCase = {
      id: requireString(entry, 'id', where),
      query: requireString(entry, 'query', where),
      seedMemoryIds: optionalStringArray(entry, 'seedMemoryIds', where),
      expectedNeighbours: neighbourExpectations(entry, where),
      forbiddenNeighbours: mentionPairs(entry, where),
      unlabelled: isUnlabelled(entry, where) || undefined,
      note: optionalNote(entry, where),
    };
    if (
      !evalCase.unlabelled &&
      evalCase.expectedNeighbours.length === 0 &&
      evalCase.forbiddenNeighbours.length === 0
    ) {
      // A case with no expectation is neither a hit nor a miss; it would be
      // counted as scored and dilute every rate on the way through.
      throw new Error(
        `${where}: labelled case "${evalCase.id}" needs expectedNeighbours or forbiddenNeighbours`,
      );
    }
    return evalCase;
  });
  assertUniqueIds(cases, filePath);
  return cases;
}

/** `expectedNeighbours`: triples, each field a non-empty string. */
function neighbourExpectations(
  entry: Record<string, unknown>,
  where: string,
): GraphNeighbourExpectation[] {
  const value = entry.expectedNeighbours;
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${where}: "expectedNeighbours" must be an array of triples`);
  }
  return value.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${where}: "expectedNeighbours[${index}]" must be an object`);
    }
    const triple = item as Record<string, unknown>;
    const at = `${where}:expectedNeighbours[${index}]`;
    return {
      subject: requireNonEmptyField(triple, 'subject', at),
      relation: requireNonEmptyField(triple, 'relation', at),
      object: requireNonEmptyField(triple, 'object', at),
    };
  });
}

/** `forbiddenNeighbours`: pairs the corpus only co-mentions. */
function mentionPairs(entry: Record<string, unknown>, where: string): GraphMentionPair[] {
  const value = entry.forbiddenNeighbours;
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${where}: "forbiddenNeighbours" must be an array of pairs`);
  }
  return value.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${where}: "forbiddenNeighbours[${index}]" must be an object`);
    }
    const pair = item as Record<string, unknown>;
    const at = `${where}:forbiddenNeighbours[${index}]`;
    return {
      subject: requireNonEmptyField(pair, 'subject', at),
      object: requireNonEmptyField(pair, 'object', at),
    };
  });
}

function requireNonEmptyField(
  entry: Record<string, unknown>,
  field: string,
  where: string,
): string {
  const value = entry[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${where}: "${field}" must be a non-empty string`);
  }
  return value;
}

function loadCorpusDeclaration(
  raw: unknown,
  dataset: KnowledgeEvalDatasetName,
  where: string,
): DatasetCorpusDeclaration {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `${where}: datasets.${dataset} must be an object declaring "corpus" or "portable"`,
    );
  }
  const entry = raw as Record<string, unknown>;
  const declaration: DatasetCorpusDeclaration = {};
  if (entry.corpus !== undefined) {
    if (typeof entry.corpus !== 'string' || entry.corpus.trim().length === 0) {
      throw new Error(`${where}: datasets.${dataset}.corpus must be a non-empty string`);
    }
    declaration.corpus = entry.corpus;
  }
  if (entry.portable !== undefined) {
    if (typeof entry.portable !== 'boolean') {
      throw new Error(`${where}: datasets.${dataset}.portable must be a boolean`);
    }
    declaration.portable = entry.portable;
  }
  if (declaration.corpus !== undefined && declaration.portable !== undefined) {
    // Both at once is a contradiction: "these exact rows" and "any corpus".
    throw new Error(
      `${where}: datasets.${dataset} declares both "corpus" and "portable" — pick one`,
    );
  }
  if (declaration.corpus === undefined && declaration.portable === undefined) {
    throw new Error(
      `${where}: datasets.${dataset} must declare "corpus" (these goldens were quoted from it) or "portable": true (they hold anywhere)`,
    );
  }
  const note = optionalNote(entry, where);
  if (note !== undefined) declaration.note = note;
  return declaration;
}

/**
 * Read `manifest.json`. Required, not optional: a dataset directory without a
 * corpus declaration is precisely the state that produced a 0.0% score nobody
 * could interpret, so the loader refuses rather than defaulting.
 */
export function loadKnowledgeEvalManifest(
  datasetDir: string = KNOWLEDGE_EVAL_DATASET_DIR,
): KnowledgeEvalManifest {
  const filePath = path.join(path.resolve(datasetDir), KNOWLEDGE_EVAL_MANIFEST_FILE);
  const where = path.join(datasetDir, KNOWLEDGE_EVAL_MANIFEST_FILE);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `${where}: missing — every dataset directory must declare which corpus its goldens were written against (see the shipped ${KNOWLEDGE_EVAL_MANIFEST_FILE})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    throw new Error(`${where}: invalid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${where}: expected a JSON object`);
  }
  const entry = parsed as Record<string, unknown>;
  if (entry.version !== KNOWLEDGE_EVAL_MANIFEST_VERSION) {
    throw new Error(
      `${where}: unsupported manifest version ${String(entry.version)} (this harness reads ${KNOWLEDGE_EVAL_MANIFEST_VERSION})`,
    );
  }
  const datasetsRaw = entry.datasets;
  if (datasetsRaw === null || typeof datasetsRaw !== 'object' || Array.isArray(datasetsRaw)) {
    throw new Error(`${where}: "datasets" must be an object keyed by dataset name`);
  }
  const datasets = datasetsRaw as Record<string, unknown>;
  const declarations = {} as Record<KnowledgeEvalDatasetName, DatasetCorpusDeclaration>;
  for (const dataset of DATASET_ORDER) {
    declarations[dataset] = loadCorpusDeclaration(datasets[dataset], dataset, where);
  }
  return { version: KNOWLEDGE_EVAL_MANIFEST_VERSION, datasets: declarations };
}

export function loadKnowledgeEvalDataset(
  datasetDir: string = KNOWLEDGE_EVAL_DATASET_DIR,
): KnowledgeEvalDataset {
  const dir = path.resolve(datasetDir);
  const manifest = loadKnowledgeEvalManifest(datasetDir);
  return {
    manifest,
    episodic: loadEpisodic(path.join(dir, 'episodic.jsonl')),
    semantic: loadSemantic(path.join(dir, 'semantic.jsonl')),
    preference: loadPreference(path.join(dir, 'preference.jsonl')),
    graph: loadGraph(path.join(dir, 'graph.jsonl')),
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

function buildIdRankingReport(
  totals: IdRankingTotals,
  unlabelledIds: string[],
  unresolvableIds: string[],
  idRecallAt5: number | null,
  applicability: { applicable: boolean; reason: string },
): IdRankingReport {
  const scored = applicability.applicable && totals.scored > 0;
  return {
    applicable: applicability.applicable,
    applicabilityReason: applicability.reason,
    labelled: totals.scored,
    unlabelled: unlabelledIds.length,
    unlabelledIds,
    unresolvable: unresolvableIds.length,
    unresolvableIds,
    idRecallAt5: scored ? idRecallAt5 : null,
    pAt5: scored ? totals.pAt5 : null,
    rAt5: scored ? totals.rAt5 : null,
    rAt10: scored ? totals.rAt10 : null,
    mrr: scored ? totals.mrr : null,
    ndcgAt5: scored ? totals.ndcgAt5 : null,
    queriesWithResults: applicability.applicable ? totals.queriesWithResults : 0,
  };
}

/**
 * A portable dataset's id goldens are only scorable where those ids exist.
 * Requiring ALL of them keeps the recall denominator honest: scoring a case
 * with one absent golden would book a guaranteed miss against the lane.
 */
function isGoldenResolvable(
  expectedIds: string[],
  declaration: DatasetCorpusDeclaration,
  idExists: ((id: string) => boolean) | undefined,
): boolean {
  if (declaration.portable !== true || idExists === undefined) return true;
  if (expectedIds.length === 0) return true;
  return expectedIds.every((id) => idExists(id));
}

/** Where in the measured top-K an expected-id hit came from. */
function matchedByLane(
  expectedIds: string[],
  hits: EvalSearchHit[],
): Array<{ lane: EvalLane; id: string }> {
  const expected = new Set(expectedIds);
  const matched: Array<{ lane: EvalLane; id: string }> = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    if (!expected.has(hit.id) || seen.has(hit.id)) continue;
    seen.add(hit.id);
    matched.push({ lane: hit.lane, id: hit.id });
  }
  return matched;
}

// ─── Graph lane ───

/**
 * Order-insensitive name pair. Direction is not scored (see `GraphReport`), and
 * a hint's two endpoints are one statement either way.
 */
function graphPairKey(subject: string, object: string): string {
  return [normaliseEvalText(subject), normaliseEvalText(object)].sort().join('\u0000');
}

function graphNeighbourKey(neighbour: GraphNeighbourExpectation): string {
  return `${graphPairKey(neighbour.subject, neighbour.object)}\u0000${normaliseEvalText(neighbour.relation)}`;
}

/** Memory hits a graph case was seeded from when it does not pin its seeds. */
function graphSeedMemoryIds(retrieval: QueryRetrieval | undefined): string[] {
  if (!retrieval) return [];
  const ids: string[] = [];
  for (const hit of retrieval.topHits) {
    if (hit.lane !== 'memories' || ids.includes(hit.id)) continue;
    ids.push(hit.id);
  }
  return ids;
}

/**
 * The graph lane ignores the fused ranking: `memory_recall` appends hints to its
 * own result, so what this scores is the hint block — expected neighbours
 * presented, mention-only pairs not presented — and nothing here can move a
 * fused metric. A provider that throws is reported (`providerError`) and scores
 * nothing, because "the graph answered nothing" and "the graph could not be
 * asked" are different facts.
 */
function scoreGraphLane(input: {
  dataset: GraphEvalCase[];
  fit: DatasetApplicability;
  hintsFor: ((memoryIds: string[]) => GraphHint[]) | undefined;
  retrievalByQuery: Map<string, QueryRetrieval>;
}): GraphReport {
  const wired = input.hintsFor !== undefined;
  const labelled = input.dataset.filter((evalCase) => !evalCase.unlabelled);
  const unlabelledIds = input.dataset.filter((evalCase) => evalCase.unlabelled).map((c) => c.id);
  const report: GraphReport = {
    applicable: wired && input.fit.applicable,
    applicabilityReason: wired
      ? input.fit.reason
      : 'the graph lane is not wired (no hints provider) — the hint block cannot be measured',
    labelled: 0,
    unlabelled: unlabelledIds.length,
    unlabelledIds,
    casesWithAllNeighbours: 0,
    neighbourAssertions: 0,
    neighboursPresented: 0,
    neighbourRecall: null,
    missedCaseIds: [],
    negativeCases: 0,
    negativeCasesClean: 0,
    negativePassRate: null,
    mentionOnlyLeakIds: [],
    hintsPresented: 0,
  };
  const hintsFor = input.hintsFor;
  if (!report.applicable || !hintsFor) return report;

  const negativeCases = labelled.filter((c) => c.forbiddenNeighbours.length > 0).length;
  const missedCaseIds: string[] = [];
  const mentionOnlyLeakIds: string[] = [];
  let casesWithAllNeighbours = 0;
  let neighbourAssertions = 0;
  let neighboursPresented = 0;
  let negativeCasesClean = 0;
  let hintsPresented = 0;

  try {
    for (const evalCase of labelled) {
      const seeds =
        evalCase.seedMemoryIds.length > 0
          ? evalCase.seedMemoryIds
          : graphSeedMemoryIds(input.retrievalByQuery.get(evalCase.query));
      const hints = hintsFor(seeds);
      hintsPresented += hints.length;
      const presentedTriples = new Set(
        hints.map(
          (hint) =>
            `${graphPairKey(hint.subject, hint.object)}\u0000${normaliseEvalText(hint.relation)}`,
        ),
      );
      const presentedPairs = new Set(hints.map((hint) => graphPairKey(hint.subject, hint.object)));

      if (evalCase.expectedNeighbours.length > 0) {
        const missing = evalCase.expectedNeighbours.filter(
          (neighbour) => !presentedTriples.has(graphNeighbourKey(neighbour)),
        );
        neighbourAssertions += evalCase.expectedNeighbours.length;
        neighboursPresented += evalCase.expectedNeighbours.length - missing.length;
        if (missing.length > 0) missedCaseIds.push(evalCase.id);
        else casesWithAllNeighbours++;
      }

      if (evalCase.forbiddenNeighbours.length > 0) {
        const leaked = evalCase.forbiddenNeighbours.some((pair) =>
          presentedPairs.has(graphPairKey(pair.subject, pair.object)),
        );
        if (leaked) mentionOnlyLeakIds.push(evalCase.id);
        else negativeCasesClean++;
      }
    }
  } catch (err) {
    report.providerError = err instanceof Error ? err.message : String(err);
    report.applicable = false;
    report.applicabilityReason = `hints provider threw: ${report.providerError}`;
    return report;
  }

  report.labelled = labelled.length;
  report.casesWithAllNeighbours = casesWithAllNeighbours;
  report.neighbourAssertions = neighbourAssertions;
  report.neighboursPresented = neighboursPresented;
  report.neighbourRecall =
    neighbourAssertions > 0 ? neighboursPresented / neighbourAssertions : null;
  report.missedCaseIds = missedCaseIds;
  report.negativeCases = negativeCases;
  report.negativeCasesClean = negativeCasesClean;
  report.negativePassRate = negativeCases > 0 ? negativeCasesClean / negativeCases : null;
  report.mentionOnlyLeakIds = mentionOnlyLeakIds;
  report.hintsPresented = hintsPresented;
  return report;
}

export async function runKnowledgeEval(
  options: RunKnowledgeEvalOptions,
): Promise<KnowledgeEvalRun> {
  const topK = Math.max(1, Math.trunc(options.topK ?? DEFAULT_TOP_K));
  const depth = Math.max(topK, RANKING_DEPTH);
  const datasetDir = options.datasetDir ?? KNOWLEDGE_EVAL_DATASET_DIR;
  const dataset = loadKnowledgeEvalDataset(datasetDir);
  const corpus = normaliseCorpusLabel(options.corpus ?? null);

  const applicability = {} as Record<KnowledgeEvalDatasetName, DatasetApplicability>;
  for (const name of DATASET_ORDER) {
    const declaration = dataset.manifest.datasets[name];
    const fit = computeCorpusFit(declaration, corpus);
    applicability[name] = {
      dataset: name,
      corpusExpectation: declaration.portable === true ? null : (declaration.corpus ?? null),
      portable: declaration.portable === true,
      applicable: fit.applicable,
      reason: fit.reason,
    };
  }

  // Every labelled case is searched, including those whose dataset turns out
  // not applicable: latency is a corpus-independent claim (G4 compares it
  // against a baseline on the same corpus), and skipping the calls would turn a
  // device run into a report with nothing measured in it at all. Nothing from
  // those datasets is scored.
  const labelledQueries: string[] = [];
  const seenQueries = new Set<string>();
  const allCases: Array<EpisodicEvalCase | SemanticEvalCase | PreferenceEvalCase | GraphEvalCase> =
    [...dataset.episodic, ...dataset.semantic, ...dataset.preference, ...dataset.graph];
  const addQuery = (query: string): void => {
    if (seenQueries.has(query)) return;
    seenQueries.add(query);
    labelledQueries.push(query);
  };
  for (const evalCase of allCases) {
    if (evalCase.unlabelled) continue;
    // A graph case with pinned seeds already knows what will be recalled, so the
    // retrieval it does not use is not paid for either.
    if ('seedMemoryIds' in evalCase && evalCase.seedMemoryIds.length > 0) continue;
    addQuery(evalCase.query);
  }

  const retrievalByQuery = new Map<string, QueryRetrieval>();
  const latencySamples: number[] = [];
  const observedLanes = new Set<EvalLane>();
  const lanesWithHits = new Set<EvalLane>();
  const laneErrors = new Map<EvalLane, string>();
  const injectedIds = new Set<string>();

  // Sequential on purpose: latencies are a product claim (G4), and running the
  // queries concurrently would measure a queue, not a retrieval.
  for (const query of labelledQueries) {
    const started = performance.now();
    let result: EvalSearchResult;
    try {
      result = await options.search(query, depth);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A search that throws is a harness-level failure, not a lane failure;
      // it is recorded against every lane the run has seen so far so the report
      // cannot present an empty result as a clean one.
      for (const lane of LANE_ORDER) {
        if (!laneErrors.has(lane)) laneErrors.set(lane, message);
      }
      retrievalByQuery.set(query, { hits: [], topHits: [], text: '' });
      continue;
    }
    latencySamples.push(performance.now() - started);

    for (const lane of LANE_ORDER) {
      const report = result.lanes[lane];
      if (!report) continue;
      observedLanes.add(lane);
      if (report.hits > 0) lanesWithHits.add(lane);
      if (report.error !== undefined && report.error !== null && !laneErrors.has(lane)) {
        laneErrors.set(lane, String(report.error));
      }
    }

    const hits = result.hits.slice(0, depth);
    for (const hit of hits) {
      if (observedLanes.has(hit.lane)) continue;
      // A hit from a lane the caller did not report as running: trust the hit,
      // because it is in the list the agent would inject, and record the lane
      // so the attribution does not silently lose it.
      observedLanes.add(hit.lane);
      lanesWithHits.add(hit.lane);
    }

    const topHits = hits.slice(0, topK);
    for (const hit of topHits) injectedIds.add(hit.id);
    retrievalByQuery.set(query, {
      hits,
      topHits,
      text: topHits.map((hit) => hit.text).join('\n'),
    });
  }

  // Every query the run issued already has its fused ids, so one map serves all
  // three datasets — which is the point: the ranking no longer depends on
  // which lane a dataset "belongs" to.
  const rankedIdsByQuery = new Map<string, string[]>();
  for (const evalCase of allCases) {
    rankedIdsByQuery.set(
      evalCase.query,
      retrievalByQuery.get(evalCase.query)?.hits.map((hit) => hit.id) ?? [],
    );
  }

  const topHitsFor = (query: string): EvalSearchHit[] => retrievalByQuery.get(query)?.topHits ?? [];

  // ── episodic: session recall ──
  const episodicUnlabelledIds = dataset.episodic.filter((c) => c.unlabelled).map((c) => c.id);
  const episodicUnresolvable: string[] = [];
  const episodicScored = dataset.episodic
    .filter((c) => !c.unlabelled)
    .filter((c) => {
      const resolvable = isGoldenResolvable(
        c.expectedMessageIds,
        dataset.manifest.datasets.episodic,
        options.idExists,
      );
      if (!resolvable) episodicUnresolvable.push(c.id);
      return resolvable && applicability.episodic.applicable;
    });
  const episodicTotals = computeIdRankingTotals(
    episodicScored.map((c) => ({ query: c.query, expectedIds: c.expectedMessageIds })),
    rankedIdsByQuery,
  );
  const episodicIdHits = episodicScored.filter(
    (c) => matchedByLane(c.expectedMessageIds, topHitsFor(c.query)).length > 0,
  ).length;
  const episodic = buildIdRankingReport(
    episodicTotals,
    episodicUnlabelledIds,
    episodicUnresolvable,
    episodicScored.length > 0 ? episodicIdHits / episodicScored.length : null,
    applicability.episodic,
  );

  // ── semantic: knowledge questions ──
  const semanticUnlabelledIds = dataset.semantic.filter((c) => c.unlabelled).map((c) => c.id);
  const semanticUnresolvable: string[] = [];
  const semanticLabels = dataset.semantic.filter((c) => !c.unlabelled);
  const semanticIdScored = semanticLabels.filter((c) => {
    const expected = c.expectedMemoryIds ?? [];
    if (expected.length === 0) return false;
    const resolvable = isGoldenResolvable(
      expected,
      dataset.manifest.datasets.semantic,
      options.idExists,
    );
    if (!resolvable) {
      semanticUnresolvable.push(c.id);
      return false;
    }
    return applicability.semantic.applicable;
  });
  const semanticTotals = computeIdRankingTotals(
    semanticIdScored.map((c) => ({ query: c.query, expectedIds: c.expectedMemoryIds ?? [] })),
    rankedIdsByQuery,
  );
  const semanticIdHits = semanticIdScored.filter(
    (c) => matchedByLane(c.expectedMemoryIds ?? [], topHitsFor(c.query)).length > 0,
  ).length;
  const semanticKeywordCases = semanticLabels.filter(
    (c) => c.expectedKeywords.length > 0 && applicability.semantic.applicable,
  );
  const semanticKeywordMisses: string[] = [];
  let semanticKeywordHits = 0;
  for (const evalCase of semanticKeywordCases) {
    const text = retrievalByQuery.get(evalCase.query)?.text ?? '';
    if (computeKeywordRecallAt5(text, evalCase.expectedKeywords)) {
      semanticKeywordHits++;
    } else {
      semanticKeywordMisses.push(evalCase.id);
    }
  }
  const keywordRecallAt5 =
    applicability.semantic.applicable && semanticKeywordCases.length > 0
      ? semanticKeywordHits / semanticKeywordCases.length
      : null;
  const semantic: IdRankingReport & KeywordReport = {
    ...buildIdRankingReport(
      semanticTotals,
      semanticUnlabelledIds,
      semanticUnresolvable,
      semanticIdScored.length > 0 ? semanticIdHits / semanticIdScored.length : null,
      applicability.semantic,
    ),
    keywordCases: semanticKeywordCases.length,
    keywordRecallAt5,
    missedCaseIds: applicability.semantic.applicable ? semanticKeywordMisses : [],
  };

  // ── preference: does the injected text carry the current value, and only it? ──
  const preferenceUnlabelledIds = dataset.preference.filter((c) => c.unlabelled).map((c) => c.id);
  const preferenceUnresolvable: string[] = [];
  const preferenceScored = dataset.preference
    .filter((c) => !c.unlabelled)
    .filter((c) => {
      const resolvable = isGoldenResolvable(
        c.mustContain,
        dataset.manifest.datasets.preference,
        options.idExists,
      );
      if (!resolvable) preferenceUnresolvable.push(c.id);
      return resolvable && applicability.preference.applicable;
    });
  let staleCases = 0;
  let staleLeaks = 0;
  let containCases = 0;
  let containHits = 0;
  const leakedCaseIds: string[] = [];
  const mustContainMissIds: string[] = [];
  for (const evalCase of preferenceScored) {
    const text = normaliseEvalText(retrievalByQuery.get(evalCase.query)?.text ?? '');
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
    applicable: applicability.preference.applicable,
    applicabilityReason: applicability.preference.reason,
    labelled: preferenceScored.length,
    unlabelled: preferenceUnlabelledIds.length,
    unlabelledIds: preferenceUnlabelledIds,
    unresolvable: preferenceUnresolvable.length,
    unresolvableIds: preferenceUnresolvable,
    mustContainCases: containCases,
    mustContainRate: containCases > 0 ? containHits / containCases : null,
    mustContainMissIds,
    staleCases,
    stalePreferenceRate: staleCases > 0 ? staleLeaks / staleCases : null,
    leakedCaseIds,
  };

  // ── graph: does the hint block present the relations the question needs? ──
  const graph = scoreGraphLane({
    dataset: dataset.graph,
    fit: applicability.graph,
    hintsFor: options.hintsFor,
    retrievalByQuery,
  });

  // ── per-lane attribution ──
  const idScoredCases: Array<{ query: string; expectedIds: string[] }> = [
    ...episodicScored.map((c) => ({ query: c.query, expectedIds: c.expectedMessageIds })),
    ...semanticIdScored.map((c) => ({ query: c.query, expectedIds: c.expectedMemoryIds ?? [] })),
  ];
  const byLane: LaneAttribution[] = LANE_ORDER.map((lane) => {
    let hits = 0;
    let queriesWithHits = 0;
    for (const evalCase of [...dataset.episodic, ...dataset.semantic, ...dataset.preference]) {
      if (evalCase.unlabelled) continue;
      const laneHits = topHitsFor(evalCase.query).filter((hit) => hit.lane === lane);
      if (laneHits.length === 0) continue;
      hits += laneHits.length;
      queriesWithHits++;
    }
    let recallSum = 0;
    let idCasesWithHit = 0;
    let relevantLaneHits = 0;
    let laneHitsScored = 0;
    for (const evalCase of idScoredCases) {
      const expected = new Set(evalCase.expectedIds);
      const laneHits = topHitsFor(evalCase.query).filter((hit) => hit.lane === lane);
      const relevant = laneHits.filter((hit) => expected.has(hit.id)).length;
      laneHitsScored += laneHits.length;
      relevantLaneHits += relevant;
      if (relevant > 0) idCasesWithHit++;
      recallSum += expected.size > 0 ? relevant / expected.size : 0;
    }
    return {
      lane,
      hits,
      queriesWithHits,
      idCases: idScoredCases.length,
      idCasesWithHit,
      idRecallAt5: idScoredCases.length > 0 ? recallSum / idScoredCases.length : null,
      precisionAt5: laneHitsScored > 0 ? relevantLaneHits / laneHitsScored : null,
    };
  });

  // ── per-case attribution ──
  const cases: EvalCaseAttribution[] = [];
  const unresolvableReason = 'its golden ids are absent from this corpus';
  const pushCase = (
    name: KnowledgeEvalDatasetName,
    evalCase: { id: string; query: string; unlabelled?: boolean },
    expectedIds: string[],
    scored: boolean,
    unresolvable: boolean,
  ): void => {
    if (evalCase.unlabelled) return;
    const fit = applicability[name];
    const skippedReason = scored
      ? undefined
      : !fit.applicable
        ? fit.reason
        : unresolvable
          ? unresolvableReason
          : 'no metric scores this case';
    const top = topHitsFor(evalCase.query);
    cases.push({
      dataset: name,
      id: evalCase.id,
      query: evalCase.query,
      scored,
      ...(skippedReason === undefined ? {} : { skippedReason }),
      hits: top.map((hit) => ({ lane: hit.lane, id: hit.id })),
      matchedIds: matchedByLane(expectedIds, top),
    });
  };
  for (const evalCase of dataset.episodic) {
    pushCase(
      'episodic',
      evalCase,
      evalCase.expectedMessageIds,
      episodicScored.some((c) => c.id === evalCase.id),
      episodicUnresolvable.includes(evalCase.id),
    );
  }
  for (const evalCase of dataset.semantic) {
    pushCase(
      'semantic',
      evalCase,
      evalCase.expectedMemoryIds ?? [],
      semanticIdScored.some((c) => c.id === evalCase.id) ||
        semanticKeywordCases.some((c) => c.id === evalCase.id),
      semanticUnresolvable.includes(evalCase.id),
    );
  }
  for (const evalCase of dataset.preference) {
    pushCase(
      'preference',
      evalCase,
      // Attribution is id-based and a preference case carries text, not ids;
      // `mustContain` is scored by the containment check, not here.
      [],
      preferenceScored.some((c) => c.id === evalCase.id),
      preferenceUnresolvable.includes(evalCase.id),
    );
  }

  // ── aggregate ──
  const latency = computeLatencyPercentiles(latencySamples);
  const hasLatency = latencySamples.length > 0;
  const metrics: EvalMetrics = {
    pAt5: aggregateMetric([
      { value: episodic.pAt5, weight: episodic.labelled },
      { value: semantic.pAt5, weight: semantic.labelled },
    ]),
    rAt5: aggregateMetric([
      { value: episodic.rAt5, weight: episodic.labelled },
      { value: semantic.rAt5, weight: semantic.labelled },
    ]),
    rAt10: aggregateMetric([
      { value: episodic.rAt10, weight: episodic.labelled },
      { value: semantic.rAt10, weight: semantic.labelled },
    ]),
    mrr: aggregateMetric([
      { value: episodic.mrr, weight: episodic.labelled },
      { value: semantic.mrr, weight: semantic.labelled },
    ]),
    ndcgAt5: aggregateMetric([
      { value: episodic.ndcgAt5, weight: episodic.labelled },
      { value: semantic.ndcgAt5, weight: semantic.labelled },
    ]),
    totalQueries: episodic.labelled + semantic.labelled,
    queriesWithResults: episodic.queriesWithResults + semantic.queriesWithResults,
    keywordRecallAt5: semantic.keywordRecallAt5,
    idRecallAt5: aggregateMetric([
      { value: episodic.idRecallAt5, weight: episodic.labelled },
      { value: semantic.idRecallAt5, weight: semantic.labelled },
    ]),
    stalePreferenceRate: preference.stalePreferenceRate,
    personaFreshness: computePersonaFreshness(
      options.personaUpdatedAt,
      options.newestActiveMemoryUpdatedAt,
    ),
    inactiveLeakageCount: options.statusLookup
      ? computeInactiveLeakageCount([...injectedIds], options.statusLookup)
      : 0,
    averageRetrievalLatencyMs: hasLatency ? latency.avg : null,
    latencyP50Ms: hasLatency ? latency.p50 : null,
    latencyP95Ms: hasLatency ? latency.p95 : null,
  };

  const lanes = LANE_ORDER.filter((lane) => observedLanes.has(lane));
  const run: KnowledgeEvalRun = {
    timestamp: new Date().toISOString(),
    harnessVersion: HARNESS_VERSION,
    summary: '',
    topK,
    corpus,
    datasetDir,
    lanes: [...lanes],
    unwiredLanes: LANE_ORDER.filter((lane) => !observedLanes.has(lane)),
    lanesWithHits: LANE_ORDER.filter((lane) => lanesWithHits.has(lane)),
    laneErrors: [...laneErrors.entries()].map(([lane, message]) => ({ lane, message })),
    datasetApplicability: DATASET_ORDER.map((name) => applicability[name]),
    statusLookupProvided: options.statusLookup !== undefined,
    byLane,
    cases,
    metrics,
    episodic,
    semantic,
    preference,
    graph,
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

function formatPercentOrNa(value: number | null): string {
  return value === null ? 'n/a' : formatPercent(value);
}

function formatDecimalOrNa(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(4);
}

function formatMs(value: number): string {
  return `${value.toFixed(1)}ms`;
}

function formatMsOrNa(value: number | null): string {
  return value === null ? 'n/a' : formatMs(value);
}

function formatLaneRow(row: LaneAttribution): string {
  return (
    `${row.lane} idRecall@5 ${formatPercentOrNa(row.idRecallAt5)}` +
    ` P@5 ${formatPercentOrNa(row.precisionAt5)}` +
    ` (${row.idCasesWithHit}/${row.idCases} case(s) with an expected id)`
  );
}

function formatDatasetDetail(run: KnowledgeEvalRun): string[] {
  const lines: string[] = [];
  const unlabelledNotes = (ids: string[]): string =>
    ids.length === 0 ? '' : `  (unlabelled: ${ids.join(', ')})`;
  const unresolvableNotes = (ids: string[]): string =>
    ids.length === 0 ? '' : `  (goldens absent from this corpus: ${ids.join(', ')})`;
  lines.push(
    `episodic:   ${run.episodic.labelled} scored, ${run.episodic.unlabelled} unlabelled${unlabelledNotes(run.episodic.unlabelledIds)}${unresolvableNotes(run.episodic.unresolvableIds)}`,
  );
  lines.push(
    `semantic:   ${run.semantic.labelled} scored, ${run.semantic.unlabelled} unlabelled${unlabelledNotes(run.semantic.unlabelledIds)}${unresolvableNotes(run.semantic.unresolvableIds)}`,
  );
  lines.push(
    `preference: ${run.preference.labelled} scored, ${run.preference.unlabelled} unlabelled${unlabelledNotes(run.preference.unlabelledIds)}` +
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
  lines.push(
    `graph:      ${run.graph.labelled} scored, ${run.graph.unlabelled} unlabelled${unlabelledNotes(run.graph.unlabelledIds)}` +
      `, ${run.graph.neighbourAssertions} expected neighbour(s), ${run.graph.negativeCases} mention-only case(s)`,
  );
  if (run.graph.missedCaseIds.length > 0) {
    lines.push(`  neighbour misses: ${run.graph.missedCaseIds.join(', ')}`);
  }
  if (run.graph.mentionOnlyLeakIds.length > 0) {
    lines.push(`  mention-only leaks: ${run.graph.mentionOnlyLeakIds.join(', ')}`);
  }
  if (run.graph.providerError !== undefined) {
    lines.push(`  hints provider error: ${run.graph.providerError}`);
  }
  return lines;
}

export function formatKnowledgeEvalReport(run: KnowledgeEvalRun): string {
  const metrics = run.metrics;
  const hitsByLane = new Map(run.byLane.map((row) => [row.lane, row.hits]));
  const laneText =
    run.lanes.length === 0
      ? '(none)'
      : run.lanes.map((lane) => `${lane} (${hitsByLane.get(lane) ?? 0} hit(s))`).join(', ');
  const fitLines = run.datasetApplicability.map(
    (fit) =>
      `  ${fit.dataset.padEnd(11)}${fit.applicable ? 'applicable    ' : 'NOT APPLICABLE'} — ${fit.reason}`,
  );
  const laneErrorLines =
    run.laneErrors.length === 0
      ? []
      : [`lane errors: ${run.laneErrors.map((e) => `${e.lane} — ${e.message}`).join(' | ')}`];
  return [
    `=== Knowledge Eval (harness v${run.harnessVersion}, fused unified search) ===`,
    `dataset: ${run.datasetDir}  topK: ${run.topK}  corpus: ${run.corpus ?? '(undeclared)'}`,
    // Both halves are always printed: a lane that was not measured must never
    // be inferred from the absence of a line.
    `lanes wired: ${laneText}  |  not wired: ${run.unwiredLanes.length > 0 ? run.unwiredLanes.join(', ') : '(none)'}`,
    ...laneErrorLines,
    'corpus fit:',
    ...fitLines,
    `id metrics over ${metrics.totalQueries} id-labelled case(s)` +
      ` (${metrics.queriesWithResults} returned a candidate)`,
    `  idRecall@5: ${formatPercentOrNa(metrics.idRecallAt5)}   keywordRecall@5: ${formatPercentOrNa(metrics.keywordRecallAt5)}`,
    `  P@5: ${formatPercentOrNa(metrics.pAt5)}   R@5: ${formatPercentOrNa(metrics.rAt5)}` +
      `   R@10: ${formatPercentOrNa(metrics.rAt10)}` +
      `   MRR: ${formatDecimalOrNa(metrics.mrr)}   NDCG@5: ${formatDecimalOrNa(metrics.ndcgAt5)}`,
    `  by lane: ${run.byLane.map(formatLaneRow).join(' | ')}`,
    `  stalePreferenceRate: ${formatPercentOrNa(metrics.stalePreferenceRate)}` +
      `   inactiveLeakageCount: ${metrics.inactiveLeakageCount}` +
      (run.statusLookupProvided ? '' : ' (no status lookup wired)'),
    `  personaFreshness: ${metrics.personaFreshness}`,
    `  latency: avg ${formatMsOrNa(metrics.averageRetrievalLatencyMs)}` +
      `   p50 ${formatMsOrNa(metrics.latencyP50Ms)}   p95 ${formatMsOrNa(metrics.latencyP95Ms)}`,
    // The graph lane is printed even when it could not run: a hint block that
    // was never measured must not be inferred from the absence of a line.
    `  graph: neighbourRecall ${formatPercentOrNa(run.graph.neighbourRecall)}` +
      ` (${run.graph.neighboursPresented}/${run.graph.neighbourAssertions})` +
      `   mentionOnlyLeaks ${run.graph.mentionOnlyLeakIds.length}` +
      `   hints ${run.graph.hintsPresented}` +
      `   ${run.graph.applicable ? '' : `[not measured: ${run.graph.applicabilityReason}]`}`.trimEnd(),
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

function formatMetricValue(value: number | null, unit: MetricRow['unit']): string {
  if (value === null) return 'n/a';
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

function formatMetricDelta(
  current: number | null,
  baseline: number | null,
  unit: MetricRow['unit'],
): string {
  if (current === null || baseline === null) return 'n/a';
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
  const baseline: KnowledgeEvalBaseline = { version: BASELINE_FILE_VERSION, ...run };
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

export type BaselineDiffStatus = 'compared' | 'refused';

export interface BaselineDiff {
  status: BaselineDiffStatus;
  /** Set when refused: what did not match. */
  reason?: string;
  /** What the CLI prints — the table, or the refusal plus the fix. */
  text: string;
}

const REGENERATE_HINT =
  'Regenerate the baseline with `pnpm eval:knowledge --corpus <label> --baseline` and diff against that.';

/**
 * Compare a run with a baseline — or refuse to.
 *
 * A delta between two different harnesses is not a measurement, it is a
 * subtraction of unlike things: v1's `MRR` came from the memory lane alone and
 * v2's from the fused list, and the same 0.35 in both files means two different
 * things. The same holds for a different lane set (a run that measured two lanes
 * is not a regression of one that measured three) and a different corpus (the
 * goldens belong to one corpus). So the gate refuses and names the fix, instead
 * of emitting a number somebody will paste into a release note.
 */
export function formatBaselineDiff(
  run: KnowledgeEvalRun,
  baseline: KnowledgeEvalBaseline,
): BaselineDiff {
  const refusals: string[] = [];
  if (baseline.version !== BASELINE_FILE_VERSION) {
    refusals.push(
      `baseline file shape version ${String(baseline.version)}, this harness writes version ${BASELINE_FILE_VERSION}`,
    );
  }
  if (baseline.harnessVersion !== run.harnessVersion) {
    refusals.push(
      `baseline harnessVersion ${String(baseline.harnessVersion)}, current harness v${run.harnessVersion}` +
        ' — the metric definitions differ, so the numbers are not comparable',
    );
  }
  const baselineLanes = [...(baseline.lanes ?? [])].sort().join(',') || '(none)';
  const currentLanes = [...run.lanes].sort().join(',') || '(none)';
  if (baselineLanes !== currentLanes) {
    refusals.push(
      `baseline measured lanes [${baselineLanes}], this run measured [${currentLanes}]`,
    );
  }
  const baselineCorpus = (baseline.corpus ?? null) || '(undeclared)';
  const currentCorpus = run.corpus ?? '(undeclared)';
  if (baselineCorpus !== currentCorpus) {
    refusals.push(`baseline corpus '${baselineCorpus}', this run corpus '${currentCorpus}'`);
  }

  if (refusals.length > 0) {
    return {
      status: 'refused',
      reason: refusals.join('; '),
      text: [
        '=== Diff vs baseline: REFUSED ===',
        ...refusals.map((line) => `  - ${line}`),
        REGENERATE_HINT,
      ].join('\n'),
    };
  }

  const lines = [
    `=== Diff vs baseline (${baseline.timestamp}, harness v${baseline.harnessVersion}) ===`,
    `baseline lanes: ${baselineLanes}   corpus: ${baselineCorpus}`,
    `${'metric'.padEnd(24)}${'baseline'.padStart(12)}${'current'.padStart(12)}${'delta'.padStart(12)}`,
  ];
  for (const row of METRIC_ROWS) {
    const before = baseline.metrics[row.key];
    const after = run.metrics[row.key];
    lines.push(
      `${row.label.padEnd(24)}${formatMetricValue(before, row.unit).padStart(12)}` +
        `${formatMetricValue(after, row.unit).padStart(12)}` +
        `${formatMetricDelta(after, before, row.unit).padStart(12)}`,
    );
  }
  lines.push(
    `${'personaFreshness'.padEnd(24)}${baseline.metrics.personaFreshness.padStart(12)}` +
      `${run.metrics.personaFreshness.padStart(12)}`,
  );
  return { status: 'compared', text: lines.join('\n') };
}

// ─── unifiedSearch wiring ───

/** `unifiedSearch()`'s lane names → this harness's. */
export function toEvalLane(lane: 'message' | 'memory' | 'knowledge'): EvalLane {
  if (lane === 'message') return 'messages';
  if (lane === 'memory') return 'memories';
  return 'knowledge';
}

/**
 * Narrow a `unifiedSearch()` result to what the harness scores.
 *
 * `lanes` is the set the caller actually requested: `unifiedSearch()` always
 * reports all three lanes, so its own map cannot distinguish "the knowledge
 * lane ran and found nothing" from "it was never wired" — and that difference
 * is what the report is required to state.
 */
export function toEvalSearchResult(
  fused: {
    hits: Array<{ lane: 'message' | 'memory' | 'knowledge'; ref: string; snippet: string }>;
    lanes: Record<
      'message' | 'memory' | 'knowledge',
      { hits: number; dropped: number; error?: string }
    >;
  },
  lanes: readonly ('message' | 'memory' | 'knowledge')[],
): EvalSearchResult {
  const reports: Partial<Record<EvalLane, EvalLaneRun>> = {};
  for (const lane of lanes) {
    const report = fused.lanes[lane];
    reports[toEvalLane(lane)] = {
      hits: report.hits,
      dropped: report.dropped,
      ...(report.error === undefined ? {} : { error: report.error }),
    };
  }
  return {
    hits: fused.hits.map((hit) => ({
      lane: toEvalLane(hit.lane),
      id: hit.ref,
      text: hit.snippet,
    })),
    lanes: reports,
  };
}

// ─── CLI ───

interface CliOptions {
  baseline: boolean;
  help: boolean;
  corpus: string | null;
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = { baseline: false, help: false, corpus: null };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--baseline') options.baseline = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--corpus') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new Error('--corpus needs a label (e.g. --corpus dev-machine)');
      }
      options.corpus = value;
      index++;
    } else if (arg.startsWith('--corpus=')) {
      options.corpus = arg.slice('--corpus='.length);
    } else throw new Error(`unknown option: ${arg} (try --help)`);
  }
  return options;
}

const CLI_HELP = `Usage: tsx src/memory/eval/knowledge-eval.ts [--baseline] [--corpus <label>]

  (no flag)        run the datasets through unifiedSearch() (message +
                   memory + knowledge lanes fused) plus the graph lane, and
                   diff the fused metrics against the newest
                   ${BASELINE_DIR}/baseline-<date>.json
  --baseline       run and archive the report as ${BASELINE_DIR}/baseline-<date>.json
  --corpus <label> declare which corpus this run measures; the shipped datasets
                   were quoted from 'dev-machine'. A corpus-specific dataset run
                   on another corpus reports "not applicable" instead of 0%.
  --help           this text

Exit codes: 0 = the run completed (including a refused diff — the diff refuses
loudly when the baseline came from another harness version, lane set or corpus),
1 = the run itself failed.

The measured object is the fused top-${DEFAULT_TOP_K} that unifiedSearch() returns,
i.e. what the agent actually injects — not one lane. Per-lane attribution is in
the report so a regression has an owner.
`;

interface LiveEvalContext {
  databasePath: string;
  options: Omit<RunKnowledgeEvalOptions, 'datasetDir' | 'corpus'>;
  /** Lanes the context actually wired, for the honest status line. */
  lanes: string[];
  close: () => void;
}

/**
 * Wires the same stack `bootstrap()` does (`src/app/composers/memory-services.ts`):
 * one database handle, the hybrid memory retriever, the knowledge service when
 * `knowledge.enabled`, all fused by `unifiedSearch()` exactly as `/api/search`
 * and `session_search` fuse them. Loaded through dynamic imports so importing
 * this module in a test does not open `config.yaml`, SQLite or pino.
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
    { unifiedSearch },
    { createKnowledgeService },
    { readHintsForMemories },
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
    import('../unified-search.js'),
    import('../knowledge/service.js'),
    import('../../graph/neighborhood.js'),
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

  const knowledgeService = config.knowledge?.enabled
    ? createKnowledgeService({
        db,
        config: {
          enabled: config.knowledge.enabled,
          requireSources: config.knowledge.curate.requireSources,
          minMemoryConfidence: config.knowledge.curate.minMemoryConfidence,
          shadow: config.knowledge.curate.shadow,
          logRetentionDays: config.knowledge.logRetentionDays,
        },
      })
    : undefined;

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

  const requested: Array<'message' | 'memory' | 'knowledge'> = ['message', 'memory'];
  if (knowledgeService) requested.push('knowledge');

  const search: EvalSearchFn = async (query, topK) => {
    const fused = await unifiedSearch({
      query,
      limit: topK,
      perLaneLimit: topK,
      lanes: requested,
      messages: { db },
      memories: {
        retriever: {
          retrieve: async (retrieval) => {
            const memories = await retriever.retrieve(retrieval);
            return memories.filter((memory) => !alwaysOnIds.has(memory.id));
          },
        },
        agentId: 'default',
      },
      ...(knowledgeService ? { knowledge: { service: knowledgeService } } : {}),
    });
    return toEvalSearchResult(fused, requested);
  };

  return {
    databasePath,
    lanes: [...requested],
    options: {
      search,
      statusLookup: (memoryId) => {
        const row = statusStatement.get(memoryId) as { status?: string } | undefined;
        return row?.status ?? null;
      },
      personaUpdatedAt: parseEpochMs(personaRow?.updated_at),
      newestActiveMemoryUpdatedAt: parseEpochMs(newestPreferenceRow?.updated_at),
      // The same reader `memory_recall` uses, so the eval scores the hint block
      // the agent would actually have seen — not a copy of the SQL.
      hintsFor: (memoryIds) => readHintsForMemories(db, memoryIds),
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
      `lanes requested: ${live.lanes.join(', ')}` +
        (live.lanes.includes('knowledge') ? '' : ' (knowledge.enabled is false)'),
    );
    const run = await runKnowledgeEval({
      ...live.options,
      datasetDir: KNOWLEDGE_EVAL_DATASET_DIR,
      corpus: options.corpus,
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
    const diff = formatBaselineDiff(run, loadBaseline(latest));
    console.log(diff.text);
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
