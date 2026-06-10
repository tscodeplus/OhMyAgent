import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openDatabase } from '../src/memory/db.js';
import { MemoryRepository } from '../src/memory/repositories/memory-repository.js';
import { EmbeddingRepository } from '../src/memory/repositories/embedding-repository.js';
import { EmbeddingCacheRepo } from '../src/memory/repositories/embedding-cache-repository.js';
import { hashContent } from '../src/memory/repositories/embedding-cache-repository.js';
import { MemoryLinkRepository } from '../src/memory/repositories/memory-link-repository.js';
import { MemoryTermRepository } from '../src/memory/repositories/memory-term-repository.js';
import { MemoryWriter } from '../src/memory/memory-writer.js';
import { MemoryRetriever } from '../src/memory/memory-retriever.js';
import { DEFAULT_PLANNER_CONFIG } from '../src/memory/query-planner.js';
import type { RecallConfig } from '../src/memory/memory-retriever.js';
import { computeV11EvalReport } from '../src/memory/eval/eval-runner.js';
import { EmbeddingClient } from '../src/provider/embedding-client.js';
import { planMemoryQueries, planStructuredQueries } from '../src/memory/query-planner.js';
import { judgeAnswer } from '../src/memory/eval/answer-judge.js';
import type { JudgeConfig, AnswerVerdict } from '../src/memory/eval/answer-judge.js';
import type { AuxModelConfig } from '../src/memory/aux-llm-client.js';
import type { LLMExpansionConfig } from '../src/memory/query-expansion-llm.js';

const ROOT = process.cwd();
const RAW_DIR = path.join(ROOT, 'data/public-eval/raw');
const FIXTURE_DIR = path.join(ROOT, 'data/public-eval/fixtures');
const RESULT_DIR = path.join(ROOT, 'data/public-eval/results');
const DOC_DIR = path.join(ROOT, 'docs/v11');
const DB_PATH = path.join(RESULT_DIR, 'public-memory-eval.sqlite');
const REPORT_PATH = path.join(DOC_DIR, 'PUBLIC_MEMORY_EVAL_REPORT.md');
const RESULT_PATH = path.join(RESULT_DIR, 'public-memory-eval-results.json');
const FIXTURE_PATH = path.join(FIXTURE_DIR, 'public-memory-eval-cases.json');
const LOCOMO_URL = 'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json';
const HF_ROWS_URL = 'https://datasets-server.huggingface.co/rows';
const HF_FIRST_ROWS_URL = 'https://datasets-server.huggingface.co/first-rows';
const HF_SIZE_URL = 'https://datasets-server.huggingface.co/size';

const LOCOMO_CASE_LIMIT = Number(process.env.PUBLIC_MEMORY_EVAL_LOCOMO_CASES ?? 12);
const LOCOMO_MAX_CASES_PER_SAMPLE = Number(process.env.PUBLIC_MEMORY_EVAL_LOCOMO_CASES_PER_SAMPLE ?? Math.max(2, Math.ceil(LOCOMO_CASE_LIMIT / 5)));
const LONGMEMEVAL_CASE_LIMIT = Number(process.env.PUBLIC_MEMORY_EVAL_LONGMEMEVAL_CASES ?? 4);
const LONGMEMEVAL_DISTRACTORS_PER_QUERY = Number(process.env.PUBLIC_MEMORY_EVAL_LONGMEMEVAL_DISTRACTORS ?? 24);
const TOP_K = Number(process.env.PUBLIC_MEMORY_EVAL_TOP_K ?? 10);
const RUN_ABLATION = process.env.PUBLIC_MEMORY_EVAL_ABLATION !== '0';
const RUN_GATE = process.env.PUBLIC_MEMORY_EVAL_GATE === '1' || process.argv.includes('--gate');
const RUN_ANSWER_JUDGE = process.env.PUBLIC_MEMORY_EVAL_ANSWER_JUDGE === '1' || process.argv.includes('--answer-judge');
const RUN_QUERY_EXPANSION = process.env.PUBLIC_MEMORY_EVAL_QUERY_EXPANSION === '1' || process.argv.includes('--query-expansion');
const EMBEDDING_BATCH_SIZE = Number(process.env.PUBLIC_MEMORY_EVAL_EMBEDDING_BATCH_SIZE ?? 32);
const EMBEDDING_TIMEOUT_MS = Number(process.env.PUBLIC_MEMORY_EVAL_EMBEDDING_TIMEOUT_MS ?? 15_000);

type DatasetName = 'locomo' | 'longmemeval';

interface EvalMemory {
  id: string;
  content: string;
  scope: string;
  scopeKey: string;
  kind: string;
  sourceMessageId?: string;
  metadata?: Record<string, unknown>;
}

interface PublicEvalCase {
  id: string;
  dataset: DatasetName;
  category: string;
  query: string;
  expectedIds: string[];
  answer?: string;
  forbiddenIds?: string[];
  scopeKey: string;
  source: string;
}

interface BuiltFixture {
  memories: EvalMemory[];
  cases: PublicEvalCase[];
  rawSnapshots: string[];
}

interface CaseResult extends PublicEvalCase {
  fixtureExpectedIds: string[];
  retrievedIds: string[];
  scoringRetrievedIds: string[];
  expectedPreviews: Array<{ id: string; content: string }>;
  retrieved: Array<{ id: string; score: number; kind: string; content: string; sourcePool?: string }>;
  latencyMs: number;
  hitAt1: boolean;
  hitAt3: boolean;
  hitAt5: boolean;
  hitAt10: boolean;
  reciprocalRank: number;
  answerEval?: {
    status: 'not_run' | 'judged';
    goldAnswerAvailable: boolean;
    verdict?: AnswerVerdict;
    generatedAnswer?: string;
    reason?: string;
    llmJudged?: boolean;
  };
}

interface AggregateMetrics {
  totalCases: number;
  hitAt1: number;
  hitAt3: number;
  hitAt5: number;
  hitAt10: number;
  mrr: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
}

interface EvalRunResult {
  lane: string;
  results: CaseResult[];
  metrics: AggregateMetrics;
  vecAvailable: boolean;
  memoryCount: number;
  embeddingCount: number;
  skippedReason?: string;
}

interface EvalRunOptions {
  lane: string;
  embeddingClient: {
    model: string;
    embedOne(text: string): Promise<Float32Array>;
    embed?(texts: string[]): Promise<Float32Array[]>;
  };
  textOnly?: boolean;
  evidenceAware?: boolean;
  writeArtifacts?: boolean;
  judge?: JudgeConfig;
  recallConfig?: RecallConfig;
  expansionConfig?: LLMExpansionConfig;
}

interface LoCoMoSample {
  sample_id: string;
  qa: Array<{
    question: string;
    answer: string;
    evidence: string[];
    category: number;
  }>;
  conversation: Record<string, unknown>;
}

interface HfRowsResponse<T> {
  rows: Array<{ row_idx: number; row: T }>;
}

interface HfSizeResponse {
  size: {
    config: { num_rows: number };
  };
}

interface LongMemEvalQueryRow {
  id: string;
  text: string;
}

interface LongMemEvalQrelRow {
  'query-id': string;
  'corpus-id': string;
  score: number;
}

interface LongMemEvalTopRankedRow {
  'query-id': string;
  'corpus-ids': string[];
}

interface LongMemEvalCorpusRow {
  id: string;
  text: string;
  title: string;
}

class DeterministicEmbeddingClient {
  readonly model = 'public-eval-hashed-token-v1';
  private readonly dimension = 384;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(text => this.embedText(text));
  }

  async embedOne(text: string): Promise<Float32Array> {
    return this.embedText(text);
  }

  private embedText(text: string): Float32Array {
    const vector = new Float32Array(this.dimension);
    const tokens = normalizeTokens(text);
    for (const token of tokens) {
      const digest = createHash('sha256').update(token).digest();
      const index = digest.readUInt16BE(0) % this.dimension;
      const sign = digest[2] % 2 === 0 ? 1 : -1;
      vector[index] += sign;
    }
    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) vector[i] /= norm;
    }
    return vector;
  }
}

const logger = {
  warn: () => undefined,
  info: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as any;

function ensureDirs(): void {
  for (const dir of [RAW_DIR, FIXTURE_DIR, RESULT_DIR, DOC_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function downloadIfMissing(url: string, outputPath: string): Promise<void> {
  if (fs.existsSync(outputPath)) return;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  fs.writeFileSync(outputPath, Buffer.from(await response.arrayBuffer()));
}

async function fetchJson<T>(url: string, outputPath?: string): Promise<T> {
  if (outputPath && fs.existsSync(outputPath)) {
    return JSON.parse(fs.readFileSync(outputPath, 'utf8')) as T;
  }
  let response: Response | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    response = await fetch(url);
    if (response.ok) break;
    if (response.status !== 429 && response.status < 500) break;
    await sleep(750 * (attempt + 1));
  }
  if (!response?.ok) {
    throw new Error(`Failed to fetch ${url}: ${response?.status} ${response?.statusText}`);
  }
  const text = await response.text();
  if (outputPath) fs.writeFileSync(outputPath, text, 'utf8');
  return JSON.parse(text) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hfUrl(baseUrl: string, config: string, extra: Record<string, string | number> = {}): string {
  const params = new URLSearchParams({
    dataset: 'mteb/LongMemEval',
    config,
    split: 'test',
  });
  for (const [key, value] of Object.entries(extra)) params.set(key, String(value));
  return `${baseUrl}?${params.toString()}`;
}

function normalizeTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 2 && !STOPWORDS.has(token));
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'you', 'your', 'was', 'were', 'are',
  'what', 'when', 'where', 'who', 'how', 'did', 'does', 'have', 'has', 'had', 'from',
  'about', 'into', 'can', 'could', 'would', 'should', 'there', 'their', 'they', 'them',
  'then', 'than', 'but', 'not', 'all', 'any', 'our', 'out', 'get', 'got', 'left',
]);

function locomoCategory(category: number): string {
  switch (category) {
    case 1: return 'locomo_single_hop';
    case 2: return 'locomo_temporal';
    case 3: return 'locomo_multi_hop';
    case 4: return 'locomo_open_domain';
    case 5: return 'locomo_adversarial';
    default: return `locomo_category_${category}`;
  }
}

async function buildLoCoMoFixture(): Promise<BuiltFixture> {
  const rawPath = path.join(RAW_DIR, 'locomo10.json');
  await downloadIfMissing(LOCOMO_URL, rawPath);
  const samples = JSON.parse(fs.readFileSync(rawPath, 'utf8')) as LoCoMoSample[];
  const memories: EvalMemory[] = [];
  const cases: PublicEvalCase[] = [];
  const seenMemories = new Set<string>();
  const categoryCounts = new Map<string, number>();

  for (const sample of samples) {
    const sampleCaseStart = cases.length;
    const conversation = sample.conversation;
    for (const [key, value] of Object.entries(conversation)) {
      if (!/^session_\d+$/.test(key) || !Array.isArray(value)) continue;
      const sessionDate = String(conversation[`${key}_date_time`] ?? '');
      const turns = value as Array<{ dia_id?: string; speaker?: string; text?: string }>;
      const sessionTurnIds: string[] = [];
      for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
        const turn = turns[turnIndex];
        if (!turn.dia_id || !turn.text) continue;
        const id = `locomo:${sample.sample_id}:${turn.dia_id}`;
        if (seenMemories.has(id)) continue;
        seenMemories.add(id);
        sessionTurnIds.push(id);
        const sessionId = turn.dia_id.split(':')[0] ?? key;
        memories.push({
          id,
          content: [
            `Dataset: LoCoMo.`,
            sessionDate ? `Session time: ${sessionDate}.` : '',
            `${turn.speaker ?? 'speaker'} said: ${turn.text}`,
          ].filter(Boolean).join(' '),
          scope: 'public_eval',
          scopeKey: `locomo:${sample.sample_id}`,
          kind: 'dialogue_turn',
          sourceMessageId: turn.dia_id,
          metadata: {
            dataset: 'locomo',
            sampleId: sample.sample_id,
            sessionId,
            turnId: turn.dia_id,
            speaker: turn.speaker ?? null,
            sessionDateTime: sessionDate || null,
            evidenceId: turn.dia_id,
            turnIndex,
          },
        });
      }
      for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
        const turn = turns[turnIndex];
        if (!turn.dia_id || !turn.text) continue;
        const sessionId = turn.dia_id.split(':')[0] ?? key;
        const windowTurns = turns
          .slice(Math.max(0, turnIndex - 1), Math.min(turns.length, turnIndex + 2))
          .filter(item => item.dia_id && item.text);
        const windowTurnIds = windowTurns.map(item => `locomo:${sample.sample_id}:${item.dia_id}`);
        const id = `locomo:${sample.sample_id}:window:${turn.dia_id}`;
        memories.push({
          id,
          content: [
            `Dataset: LoCoMo turn window.`,
            sessionDate ? `Session time: ${sessionDate}.` : '',
            ...windowTurns.map(item => `${item.speaker ?? 'speaker'} said: ${item.text}`),
          ].filter(Boolean).join(' '),
          scope: 'public_eval',
          scopeKey: `locomo:${sample.sample_id}`,
          kind: 'dialogue_turn_window',
          sourceMessageId: `window:${turn.dia_id}`,
          metadata: {
            dataset: 'locomo',
            sampleId: sample.sample_id,
            sessionId,
            centerMemoryId: `locomo:${sample.sample_id}:${turn.dia_id}`,
            windowTurnIds,
            sessionDateTime: sessionDate || null,
            turnIndex,
          },
        });
      }
      if (sessionTurnIds.length > 0) {
        const summaryId = `locomo:${sample.sample_id}:session:${key}`;
        memories.push({
          id: summaryId,
          content: [
            `Dataset: LoCoMo session summary.`,
            sessionDate ? `Session time: ${sessionDate}.` : '',
            `Session ${key} includes ${sessionTurnIds.length} turns.`,
            ...turns
              .filter(item => item.dia_id && item.text)
              .slice(0, 24)
              .map(item => `${item.dia_id} ${item.speaker ?? 'speaker'}: ${item.text}`),
          ].filter(Boolean).join(' '),
          scope: 'public_eval',
          scopeKey: `locomo:${sample.sample_id}`,
          kind: 'dialogue_session_summary',
          sourceMessageId: `session:${key}`,
          metadata: {
            dataset: 'locomo',
            sampleId: sample.sample_id,
            sessionId: key,
            childMemoryIds: sessionTurnIds,
            sessionDateTime: sessionDate || null,
          },
        });
      }
    }

    for (const [index, qa] of sample.qa.entries()) {
      if (cases.filter(c => c.dataset === 'locomo').length >= LOCOMO_CASE_LIMIT) break;
      if (cases.length - sampleCaseStart >= LOCOMO_MAX_CASES_PER_SAMPLE) break;
      const expectedIds = qa.evidence.map(evidence => `locomo:${sample.sample_id}:${evidence}`);
      if (expectedIds.length === 0 || !expectedIds.every(id => seenMemories.has(id))) continue;
      const category = locomoCategory(qa.category);
      const categoryTarget = Math.max(1, Math.ceil(LOCOMO_CASE_LIMIT / 4));
      if ((categoryCounts.get(category) ?? 0) >= categoryTarget && cases.length < LOCOMO_CASE_LIMIT - 2) {
        continue;
      }
      cases.push({
        id: `locomo:${sample.sample_id}:qa:${index}`,
        dataset: 'locomo',
        category,
        query: qa.question,
        expectedIds,
        answer: qa.answer,
        scopeKey: `locomo:${sample.sample_id}`,
        source: 'snap-research/locomo data/locomo10.json',
      });
      categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    }
    if (cases.filter(c => c.dataset === 'locomo').length >= LOCOMO_CASE_LIMIT) break;
  }

  return { memories, cases, rawSnapshots: [rawPath] };
}

function parseCorpusId(id: string): { scene: number; session: number } {
  const match = /^scene_(\d+)_session_(\d+)$/.exec(id);
  if (!match) throw new Error(`Unexpected LongMemEval corpus id: ${id}`);
  return { scene: Number(match[1]), session: Number(match[2]) };
}

async function fetchHfRows<T>(config: string, length: number, offset = 0, outputName?: string): Promise<Array<{ row_idx: number; row: T }>> {
  const outputPath = outputName ? path.join(RAW_DIR, outputName) : undefined;
  const response = await fetchJson<HfRowsResponse<T>>(
    hfUrl(offset === 0 ? HF_FIRST_ROWS_URL : HF_ROWS_URL, config, offset === 0 ? {} : { offset, length }),
    outputPath,
  );
  return response.rows.slice(0, length);
}

async function longMemEvalCorpusSize(): Promise<number> {
  const response = await fetchJson<HfSizeResponse>(
    hfUrl(HF_SIZE_URL, 'multi_session-corpus').replace('&split=test', ''),
    path.join(RAW_DIR, 'longmemeval-multi_session-corpus-size.json'),
  );
  return response.size.config.num_rows;
}

async function corpusRowAt(offset: number): Promise<LongMemEvalCorpusRow> {
  const rows = await fetchHfRows<LongMemEvalCorpusRow>('multi_session-corpus', 1, offset);
  if (rows.length === 0) throw new Error(`No corpus row at offset ${offset}`);
  return rows[0].row;
}

async function findSceneStartOffset(scene: number, totalRows: number): Promise<number> {
  let low = 0;
  let high = totalRows - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const row = await corpusRowAt(mid);
    const parsed = parseCorpusId(row.id);
    if (parsed.scene < scene) low = mid + 1;
    else high = mid;
  }
  const row = await corpusRowAt(low);
  if (parseCorpusId(row.id).scene !== scene) {
    throw new Error(`Could not locate LongMemEval scene_${scene}; nearest row is ${row.id}`);
  }
  return low;
}

async function fetchCorpusRowsByIds(ids: string[]): Promise<Map<string, LongMemEvalCorpusRow>> {
  const rowsById = new Map<string, LongMemEvalCorpusRow>();
  const parsed = ids.map(id => ({ id, ...parseCorpusId(id) }));
  const minScene = Math.min(...parsed.map(item => item.scene));
  const maxScene = Math.max(...parsed.map(item => item.scene));

  // The first public LongMemEval batch starts at scene_126. Fetching one scene
  // window is much kinder to the Hugging Face rows API than probing per row.
  const estimatedScene126Start = 59893;
  const estimatedRowsPerScene = 520;
  const windowOffset = Math.max(0, estimatedScene126Start + (minScene - 126) * estimatedRowsPerScene - 50);
  const windowLength = (maxScene - minScene + 1) * estimatedRowsPerScene + 100;
  const rawRowsPath = path.join(RAW_DIR, 'longmemeval-selected-corpus-window.json');
  let rawRows: Array<{ row_idx: number; row: LongMemEvalCorpusRow }>;
  if (fs.existsSync(rawRowsPath)) {
    rawRows = JSON.parse(fs.readFileSync(rawRowsPath, 'utf8')) as Array<{ row_idx: number; row: LongMemEvalCorpusRow }>;
  } else {
    rawRows = [];
    for (let offset = windowOffset; offset < windowOffset + windowLength; offset += 100) {
      const length = Math.min(100, windowOffset + windowLength - offset);
      rawRows.push(...await fetchHfRows<LongMemEvalCorpusRow>('multi_session-corpus', length, offset));
      await sleep(500);
    }
    fs.writeFileSync(rawRowsPath, JSON.stringify(rawRows, null, 2), 'utf8');
  }

  for (const id of ids) {
    const found = rawRows.find(row => row.row.id === id)?.row;
    if (!found) throw new Error(`Could not fetch LongMemEval corpus row ${id} in selected corpus window`);
    rowsById.set(id, found);
  }

  fs.writeFileSync(
    path.join(RAW_DIR, 'longmemeval-selected-corpus-rows.json'),
    JSON.stringify(dedupeRows(rawRows), null, 2),
    'utf8',
  );
  return rowsById;
}

function dedupeRows<T extends { row: { id?: string } }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter(row => {
    const key = row.row.id ?? JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function buildLongMemEvalFixture(): Promise<BuiltFixture> {
  const queryRows = await fetchHfRows<LongMemEvalQueryRow>(
    'multi_session-queries',
    LONGMEMEVAL_CASE_LIMIT,
    0,
    'longmemeval-multi_session-queries-first-rows.json',
  );
  const qrelRows = await fetchHfRows<LongMemEvalQrelRow>(
    'multi_session-qrels',
    LONGMEMEVAL_CASE_LIMIT * 2,
    0,
    'longmemeval-multi_session-qrels-first-rows.json',
  );
  const topRankedRows = await fetchHfRows<LongMemEvalTopRankedRow>(
    'multi_session-top_ranked',
    LONGMEMEVAL_CASE_LIMIT,
    0,
    'longmemeval-multi_session-top-ranked-first-rows.json',
  );

  const qrelsByQuery = new Map<string, string[]>();
  for (const { row } of qrelRows) {
    const ids = qrelsByQuery.get(row['query-id']) ?? [];
    ids.push(row['corpus-id']);
    qrelsByQuery.set(row['query-id'], ids);
  }
  const topRankedByQuery = new Map(topRankedRows.map(({ row }) => [row['query-id'], row['corpus-ids']]));
  const selectedQueries = queryRows.filter(({ row }) => qrelsByQuery.has(row.id)).slice(0, LONGMEMEVAL_CASE_LIMIT);
  const corpusIds = new Set<string>();

  for (const { row } of selectedQueries) {
    const relevant = qrelsByQuery.get(row.id) ?? [];
    for (const id of relevant) corpusIds.add(id);
    for (const id of (topRankedByQuery.get(row.id) ?? []).slice(0, LONGMEMEVAL_DISTRACTORS_PER_QUERY)) {
      corpusIds.add(id);
    }
  }

  const corpusRows = await fetchCorpusRowsByIds([...corpusIds]);
  const memories: EvalMemory[] = [...corpusRows.values()].map(row => ({
    id: `longmemeval:${row.id}`,
    content: `Dataset: LongMemEval. ${row.title}. ${row.text}`,
    scope: 'public_eval',
    scopeKey: 'longmemeval:multi_session',
    kind: 'dialogue_session',
    sourceMessageId: row.id,
    metadata: {
      dataset: 'longmemeval',
      corpusId: row.id,
      ...parseCorpusId(row.id),
      title: row.title,
    },
  }));
  const cases: PublicEvalCase[] = selectedQueries.map(({ row }) => ({
    id: `longmemeval:${row.id}`,
    dataset: 'longmemeval',
    category: 'longmemeval_multi_session',
    query: row.text,
    expectedIds: (qrelsByQuery.get(row.id) ?? []).map(id => `longmemeval:${id}`),
    scopeKey: 'longmemeval:multi_session',
    source: 'mteb/LongMemEval multi_session retrieval task',
  }));

  return {
    memories,
    cases,
    rawSnapshots: [
      path.join(RAW_DIR, 'longmemeval-multi_session-queries-first-rows.json'),
      path.join(RAW_DIR, 'longmemeval-multi_session-qrels-first-rows.json'),
      path.join(RAW_DIR, 'longmemeval-multi_session-top-ranked-first-rows.json'),
      path.join(RAW_DIR, 'longmemeval-selected-corpus-window.json'),
      path.join(RAW_DIR, 'longmemeval-selected-corpus-rows.json'),
    ],
  };
}

function cleanupDatabase(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${DB_PATH}${suffix}`;
    if (fs.existsSync(file)) fs.rmSync(file);
  }
}

async function runEval(fixture: BuiltFixture, options: EvalRunOptions): Promise<EvalRunResult> {
  cleanupDatabase();
  const db = openDatabase(DB_PATH);
  const memoryRepository = new MemoryRepository(db);
  const embeddingRepository = new EmbeddingRepository(db);
  const embeddingCacheRepo = new EmbeddingCacheRepo(db, 50000);
  const memoryLinkRepo = new MemoryLinkRepository(db);
  const memoryTermRepo = new MemoryTermRepository(db);
  const embeddingClient = options.embeddingClient;
  const writer = new MemoryWriter(
    memoryRepository,
    embeddingRepository,
    embeddingClient as any,
    embeddingCacheRepo,
    undefined,
    undefined,
    undefined,
    memoryLinkRepo,
    undefined,
    memoryTermRepo,
  );

  await warmEmbeddingCache(
    embeddingClient,
    embeddingCacheRepo,
    [
      ...fixture.memories.map(memory => memory.content),
      ...fixture.cases.map(evalCase => evalCase.query),
      ...fixture.cases.flatMap(evalCase => planMemoryQueries(evalCase.query).map(query => query.query)),
      // Coverage-path slot queries so per-entity/shared searches hit warm cache too.
      ...fixture.cases.flatMap(evalCase =>
        planStructuredQueries(evalCase.query).slots.flatMap(slot => slot.queries),
      ),
    ],
  );
  const retriever = new MemoryRetriever(
    memoryRepository,
    embeddingRepository,
    embeddingClient as any,
    embeddingCacheRepo,
    db,
    options.expansionConfig ?? {
      enabled: false,
      minQueryLength: 15,
      minScoreTrigger: 0.3,
      maxVariants: 0,
      logger,
    },
    undefined,
    { halfLifeDays: 36500 },
    0.01,
    memoryLinkRepo,
    undefined,
    undefined,
    DEFAULT_PLANNER_CONFIG,
    options.recallConfig,
  );

  const writtenIds = new Map<string, string>();
  for (const memory of fixture.memories) {
    const result = await writer.write({
      id: memory.id,
      content: memory.content,
      scope: memory.scope,
      scopeKey: memory.scopeKey,
      kind: memory.kind,
      metadata: memory.metadata,
      sourceChannel: 'public_eval',
      sourceMessageId: memory.sourceMessageId,
      generateEmbedding: true,
      dedupThreshold: 0.999,
    });
    writtenIds.set(memory.id, result.id);
  }
  embeddingRepository.backfillVec();

  const results: CaseResult[] = [];
  for (const evalCase of fixture.cases) {
    const started = performance.now();
    const retrieved = await retriever.retrieve({
      query: evalCase.query,
      scope: 'public_eval',
      scopeKey: evalCase.scopeKey,
      topK: TOP_K,
      minScore: 0.01,
      textOnly: options.textOnly,
    });
    const latencyMs = performance.now() - started;
    const expectedIds = evalCase.expectedIds.flatMap(id => {
      const writtenId = writtenIds.get(id);
      return writtenId ? [writtenId] : [];
    });
    const retrievedIds = retrieved.map(memory => memory.id);
    const scoringRetrievedIds = options.evidenceAware === false
      ? retrievedIds
      : retrievedIds.map(id => {
          const covered = coveredMemoryIds(memoryRepository, id);
          return expectedIds.find(expectedId => covered.includes(expectedId)) ?? id;
        });
    const ranks = expectedIds
      .map(id => scoringRetrievedIds.indexOf(id))
      .filter(index => index >= 0)
      .sort((a, b) => a - b);
    const firstRank = ranks[0];

    // Answer-level judgement (eval-only, gated). Generation sees ONLY retrieved
    // content; gold is used solely for the final grading comparison.
    let answerEval: CaseResult['answerEval'];
    if (evalCase.answer === undefined) {
      answerEval = undefined;
    } else if (!options.judge) {
      answerEval = { status: 'not_run', goldAnswerAvailable: true };
    } else {
      const judged = await judgeAnswer(
        evalCase.query,
        retrieved.map(memory => memory.content),
        evalCase.answer,
        options.judge,
      );
      answerEval = {
        status: 'judged',
        goldAnswerAvailable: true,
        verdict: judged.verdict,
        generatedAnswer: judged.generatedAnswer,
        reason: judged.reason,
        llmJudged: judged.llmJudged,
      };
    }

    results.push({
      ...evalCase,
      fixtureExpectedIds: evalCase.expectedIds,
      expectedIds,
      expectedPreviews: expectedIds.map(id => ({
        id,
        content: preview(memoryRepository.findById(id)?.content ?? ''),
      })),
      retrievedIds,
      scoringRetrievedIds,
      retrieved: retrieved.map(memory => ({
        id: memory.id,
        score: memory.score,
        kind: memory.kind,
        content: preview(memory.content),
        sourcePool: memory.sourcePool,
      })),
      latencyMs,
      hitAt1: firstRank === 0,
      hitAt3: firstRank !== undefined && firstRank < 3,
      hitAt5: firstRank !== undefined && firstRank < 5,
      hitAt10: firstRank !== undefined && firstRank < 10,
      reciprocalRank: firstRank === undefined ? 0 : 1 / (firstRank + 1),
      answerEval,
    });
  }

  const memoryCount = (db.prepare('SELECT COUNT(*) AS count FROM memories').get() as { count: number }).count;
  const embeddingCount = embeddingRepository.count();
  const vecAvailable = embeddingRepository.isVecAvailable();
  const metrics = aggregate(results);
  db.close();
  return {
    lane: options.lane,
    results,
    metrics,
    vecAvailable,
    memoryCount,
    embeddingCount,
  };
}

function coveredMemoryIds(memoryRepository: MemoryRepository, id: string): string[] {
  const memory = memoryRepository.findById(id);
  if (!memory?.metadata) return [id];
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(memory.metadata) as Record<string, unknown>;
  } catch {
    return [id];
  }
  return [
    id,
    ...readStringArray(metadata.centerMemoryId),
    ...readStringArray(metadata.windowTurnIds),
    ...readStringArray(metadata.childMemoryIds),
  ];
}

function readStringArray(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function aggregate(results: CaseResult[]): AggregateMetrics {
  const totalCases = results.length || 1;
  const latencies = results.map(result => result.latencyMs).sort((a, b) => a - b);
  return {
    totalCases: results.length,
    hitAt1: results.filter(result => result.hitAt1).length / totalCases,
    hitAt3: results.filter(result => result.hitAt3).length / totalCases,
    hitAt5: results.filter(result => result.hitAt5).length / totalCases,
    hitAt10: results.filter(result => result.hitAt10).length / totalCases,
    mrr: results.reduce((sum, result) => sum + result.reciprocalRank, 0) / totalCases,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
  };
}

function aggregateByDataset(results: CaseResult[]): Record<string, AggregateMetrics> {
  const grouped = new Map<string, CaseResult[]>();
  for (const result of results) {
    const values = grouped.get(result.dataset) ?? [];
    values.push(result);
    grouped.set(result.dataset, values);
  }
  return Object.fromEntries([...grouped.entries()].map(([dataset, values]) => [dataset, aggregate(values)]));
}

function aggregateByCategory(results: CaseResult[]): Record<string, AggregateMetrics> {
  const grouped = new Map<string, CaseResult[]>();
  for (const result of results) {
    const values = grouped.get(result.category) ?? [];
    values.push(result);
    grouped.set(result.category, values);
  }
  return Object.fromEntries([...grouped.entries()].map(([category, values]) => [category, aggregate(values)]));
}

interface AnswerAccuracy {
  judged: number;
  correct: number;
  partial: number;
  incorrect: number;
  skipped: number;
  /** correct / judged-non-skipped. */
  accuracy: number;
  /** (correct + 0.5*partial) / judged-non-skipped. */
  weightedAccuracy: number;
}

function aggregateAnswerAccuracy(results: CaseResult[]): AnswerAccuracy {
  const judgedResults = results.filter(r => r.answerEval?.status === 'judged');
  let correct = 0, partial = 0, incorrect = 0, skipped = 0;
  for (const r of judgedResults) {
    switch (r.answerEval?.verdict) {
      case 'correct': correct++; break;
      case 'partial': partial++; break;
      case 'incorrect': incorrect++; break;
      default: skipped++; break;
    }
  }
  const scored = correct + partial + incorrect;
  return {
    judged: judgedResults.length,
    correct, partial, incorrect, skipped,
    accuracy: scored === 0 ? 0 : correct / scored,
    weightedAccuracy: scored === 0 ? 0 : (correct + 0.5 * partial) / scored,
  };
}

function answerAccuracyByCategory(results: CaseResult[]): Record<string, AnswerAccuracy> {
  const grouped = new Map<string, CaseResult[]>();
  for (const result of results) {
    if (result.answerEval?.status !== 'judged') continue;
    const values = grouped.get(result.category) ?? [];
    values.push(result);
    grouped.set(result.category, values);
  }
  return Object.fromEntries([...grouped.entries()].map(([category, values]) => [category, aggregateAnswerAccuracy(values)]));
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.ceil(values.length * percentileValue) - 1);
  return values[index];
}

function writeFixture(fixture: BuiltFixture): void {
  fs.writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2), 'utf8');
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatMs(value: number): string {
  return `${value.toFixed(1)} ms`;
}

function preview(content: string, maxLength = 180): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 3)}...`;
}

function createConfiguredEmbeddingClient(): EmbeddingClient | undefined {
  const apiKey = process.env.PUBLIC_MEMORY_EVAL_EMBEDDING_API_KEY || process.env.EMBEDDING_API_KEY;
  const baseUrl = process.env.PUBLIC_MEMORY_EVAL_EMBEDDING_BASE_URL || process.env.EMBEDDING_BASE_URL;
  const model = process.env.PUBLIC_MEMORY_EVAL_EMBEDDING_MODEL || process.env.EMBEDDING_MODEL;
  const dimension = Number(process.env.PUBLIC_MEMORY_EVAL_EMBEDDING_DIMENSION || process.env.EMBEDDING_DIMENSION || 0);
  if (!apiKey || !baseUrl || !model || !dimension) return undefined;
  return new EmbeddingClient({ apiKey, baseUrl, model, dimension });
}

/**
 * Build an answer-level judge from env, or return undefined to skip gracefully.
 * Gated behind --answer-judge / PUBLIC_MEMORY_EVAL_ANSWER_JUDGE=1 so the default
 * offline run never makes LLM calls. The model never sees gold during generation
 * (see answer-judge.ts); gold is only used for the final grading comparison.
 */
function createConfiguredJudge(): JudgeConfig | undefined {
  if (!RUN_ANSWER_JUDGE) return undefined;
  const modelRef = process.env.PUBLIC_MEMORY_EVAL_JUDGE_MODEL;
  const apiKey = process.env.PUBLIC_MEMORY_EVAL_JUDGE_API_KEY;
  const baseUrl = process.env.PUBLIC_MEMORY_EVAL_JUDGE_BASE_URL;
  if (!modelRef || !apiKey || !baseUrl) {
    console.warn('[answer-judge] requested but PUBLIC_MEMORY_EVAL_JUDGE_{MODEL,API_KEY,BASE_URL} not all set — skipping');
    return undefined;
  }
  // modelRef is "provider/model"; key the apiKey under that provider.
  const provider = modelRef.includes('/') ? modelRef.split('/')[0] : '*';
  const auxConfig: AuxModelConfig = {
    modelRef,
    apiKeys: { [provider]: apiKey, '*': apiKey },
    baseUrls: { [provider]: baseUrl },
    baseUrl,
  };
  return { auxConfig, maxContexts: 10, maxContextChars: 600, logger };
}

/**
 * Build an LLM query-expansion config from env, or undefined to skip.
 * Gated behind --query-expansion / PUBLIC_MEMORY_EVAL_QUERY_EXPANSION=1.
 *
 * Defaults to nvidia-hosted deepseek-ai/deepseek-v4-flash — a non-reasoning
 * model that emits clean line-per-variant output (the deepseek.com variant is
 * a reasoning model that burns the token budget on hidden thinking).
 *
 * Two lanes use this with different minQueryLength:
 *   - forced (minQueryLength 10000): the retriever still probes and passes a
 *     real initialMaxScore, but the huge length threshold guarantees the gate
 *     fires on every query — an upper-bound study of what expansion can recover.
 *   - gated (minQueryLength 15): production-realistic. Expansion only runs when
 *     the probe's top similarity is below minScoreTrigger, so most queries skip
 *     the LLM entirely and only weak-recall queries pay the cost.
 */
function createConfiguredExpansion(overrides?: { minQueryLength?: number }): LLMExpansionConfig | undefined {
  if (!RUN_QUERY_EXPANSION) return undefined;
  const modelRef = process.env.PUBLIC_MEMORY_EVAL_EXPANSION_MODEL || 'nvidia/deepseek-ai/deepseek-v4-flash';
  const apiKey = process.env.PUBLIC_MEMORY_EVAL_EXPANSION_API_KEY || process.env.PI_AI_API_KEY;
  const baseUrl = process.env.PUBLIC_MEMORY_EVAL_EXPANSION_BASE_URL || 'https://integrate.api.nvidia.com/v1';
  if (!apiKey) {
    console.warn('[query-expansion] requested but no API key (set PUBLIC_MEMORY_EVAL_EXPANSION_API_KEY or PI_AI_API_KEY) — skipping');
    return undefined;
  }
  const provider = modelRef.includes('/') ? modelRef.split('/')[0] : '*';
  const auxConfig: AuxModelConfig = {
    modelRef,
    apiKeys: { [provider]: apiKey, '*': apiKey },
    baseUrls: { [provider]: baseUrl },
    baseUrl,
  };
  return {
    auxConfig,
    enabled: true,
    minQueryLength: overrides?.minQueryLength
      ?? Number(process.env.PUBLIC_MEMORY_EVAL_EXPANSION_MIN_QUERY_LENGTH ?? 10000),
    minScoreTrigger: Number(process.env.PUBLIC_MEMORY_EVAL_EXPANSION_MIN_SCORE_TRIGGER ?? 0.3),
    maxVariants: Number(process.env.PUBLIC_MEMORY_EVAL_EXPANSION_MAX_VARIANTS ?? 4),
    logger,
  };
}

async function warmEmbeddingCache(
  embeddingClient: EvalRunOptions['embeddingClient'],
  embeddingCacheRepo: EmbeddingCacheRepo,
  texts: string[],
): Promise<void> {
  const uniqueTexts = [...new Set(texts.map(text => text.trim()).filter(Boolean))];
  const missing = uniqueTexts.filter(text => !embeddingCacheRepo.get(hashContent(text, embeddingClient.model)));
  for (let i = 0; i < missing.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = missing.slice(i, i + EMBEDDING_BATCH_SIZE);
    await warmEmbeddingBatch(embeddingClient, embeddingCacheRepo, batch);
  }
}

async function warmEmbeddingBatch(
  embeddingClient: EvalRunOptions['embeddingClient'],
  embeddingCacheRepo: EmbeddingCacheRepo,
  batch: string[],
): Promise<void> {
  if (batch.length === 0) return;
  try {
    const embeddings = await withTimeout(
      embeddingClient.embed ? embeddingClient.embed(batch) : Promise.all(batch.map(text => embeddingClient.embedOne(text))),
      EMBEDDING_TIMEOUT_MS,
      `embedding batch timeout after ${EMBEDDING_TIMEOUT_MS}ms`,
    );
    for (let index = 0; index < batch.length; index++) {
      const embedding = embeddings[index];
      if (!embedding) continue;
      embeddingCacheRepo.set({
        content_hash: hashContent(batch[index], embeddingClient.model),
        embedding: Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
        model: embeddingClient.model,
        dimension: embedding.length,
        created_at: new Date().toISOString(),
      });
    }
  } catch (err) {
    if (batch.length === 1) {
      console.warn(`Embedding cache warmup skipped one item: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const mid = Math.ceil(batch.length / 2);
    await warmEmbeddingBatch(embeddingClient, embeddingCacheRepo, batch.slice(0, mid));
    await warmEmbeddingBatch(embeddingClient, embeddingCacheRepo, batch.slice(mid));
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs)),
  ]);
}

function metricsTable(metricsByDataset: Record<string, AggregateMetrics>, overall: AggregateMetrics): string {
  const rows = [
    ['dataset', 'cases', 'Hit@1', 'Hit@3', 'Hit@5', 'Hit@10', 'MRR', 'p50', 'p95'],
    ...Object.entries(metricsByDataset).map(([dataset, metrics]) => [
      dataset,
      String(metrics.totalCases),
      formatPercent(metrics.hitAt1),
      formatPercent(metrics.hitAt3),
      formatPercent(metrics.hitAt5),
      formatPercent(metrics.hitAt10),
      metrics.mrr.toFixed(4),
      formatMs(metrics.p50LatencyMs),
      formatMs(metrics.p95LatencyMs),
    ]),
    [
      'overall',
      String(overall.totalCases),
      formatPercent(overall.hitAt1),
      formatPercent(overall.hitAt3),
      formatPercent(overall.hitAt5),
      formatPercent(overall.hitAt10),
      overall.mrr.toFixed(4),
      formatMs(overall.p50LatencyMs),
      formatMs(overall.p95LatencyMs),
    ],
  ];
  return [
    `| ${rows[0].join(' | ')} |`,
    `| ${rows[0].map(() => '---').join(' | ')} |`,
    ...rows.slice(1).map(row => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function laneTable(runs: EvalRunResult[]): string {
  const rows = [
    ['lane', 'status', 'cases', 'Hit@1', 'Hit@3', 'Hit@10', 'MRR', 'p95'],
    ...runs.map(run => {
      if (run.skippedReason) {
        return [run.lane, `skipped: ${run.skippedReason}`, '-', '-', '-', '-', '-', '-'];
      }
      return [
        run.lane,
        'ok',
        String(run.metrics.totalCases),
        formatPercent(run.metrics.hitAt1),
        formatPercent(run.metrics.hitAt3),
        formatPercent(run.metrics.hitAt10),
        run.metrics.mrr.toFixed(4),
        formatMs(run.metrics.p95LatencyMs),
      ];
    }),
  ];
  return [
    `| ${rows[0].join(' | ')} |`,
    `| ${rows[0].map(() => '---').join(' | ')} |`,
    ...rows.slice(1).map(row => `| ${row.join(' | ')} |`),
  ].join('\n');
}

/**
 * Per-lane × per-category Hit@10 grid. Makes the single_hop/open_domain effect
 * of each lane visible — the flat laneTable only shows pooled overall numbers,
 * which hides where a lane actually moved the needle.
 */
function laneCategoryTable(runs: EvalRunResult[]): string {
  const active = runs.filter(run => !run.skippedReason && run.results.length > 0);
  if (active.length === 0) return '_No active lanes._';
  const categories = [...new Set(active.flatMap(run => run.results.map(r => r.category)))].sort();
  const header = ['lane', ...categories];
  const rows = active.map(run => {
    const byCat = aggregateByCategory(run.results);
    return [run.lane, ...categories.map(cat => (byCat[cat] ? formatPercent(byCat[cat].hitAt10) : '-'))];
  });
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function answerAccuracyTable(byCategory: Record<string, AnswerAccuracy>, overall: AnswerAccuracy): string {
  const toRow = (label: string, a: AnswerAccuracy) => [
    label,
    String(a.judged),
    String(a.correct),
    String(a.partial),
    String(a.incorrect),
    String(a.skipped),
    formatPercent(a.accuracy),
    formatPercent(a.weightedAccuracy),
  ];
  const rows = [
    ['category', 'judged', 'correct', 'partial', 'wrong', 'skip', 'acc', 'w-acc'],
    ...Object.entries(byCategory).map(([category, a]) => toRow(category, a)),
    toRow('overall', overall),
  ];
  return [
    `| ${rows[0].join(' | ')} |`,
    `| ${rows[0].map(() => '---').join(' | ')} |`,
    ...rows.slice(1).map(row => `| ${row.join(' | ')} |`),
  ].join('\n');
}

/** Markdown lines for the answer-level section; empty/note when judging didn't run. */
function answerReportLines(results: CaseResult[]): string[] {
  const acc = aggregateAnswerAccuracy(results);
  if (acc.judged === 0) return [];
  return [
    '',
    answerAccuracyTable(answerAccuracyByCategory(results), acc),
  ];
}

function writeReport(
  fixture: BuiltFixture,
  primaryRun: EvalRunResult,
  allRuns: EvalRunResult[],
): void {
  const results = primaryRun.results;
  const metrics = primaryRun.metrics;
  const vecAvailable = primaryRun.vecAvailable;
  const memoryCount = primaryRun.memoryCount;
  const embeddingCount = primaryRun.embeddingCount;
  const byDataset = aggregateByDataset(results);
  const gateEligibleResults = results.filter(isGateEligibleCase);
  const gateMetrics = aggregate(gateEligibleResults);
  const v11Report = computeV11EvalReport(results.map(result => ({
    id: result.id,
    category: result.category,
    query: result.query,
    retrievedIds: result.scoringRetrievedIds,
    expectedIds: result.expectedIds,
    forbiddenIds: result.forbiddenIds,
  })));
  const failed = results.filter(result => !result.hitAt10).slice(0, 12);
  const lines = [
    '# V11 Public Memory Eval Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Goal',
    '',
    'Run the memory system against a reproducible first batch of public long-term-memory datasets using a temporary SQLite database, persisted fixture data, and the real write/retrieve pipeline.',
    '',
    '## Data',
    '',
    '- LoCoMo: long-term conversational QA cases from `snap-research/locomo`.',
    '- LongMemEval: MTEB `multi_session` retrieval rows from `mteb/LongMemEval`.',
    `- Raw snapshots: ${fixture.rawSnapshots.map(file => `\`${path.relative(ROOT, file)}\``).join(', ')}.`,
    `- Converted fixture: \`${path.relative(ROOT, FIXTURE_PATH)}\`.`,
    `- Raw results: \`${path.relative(ROOT, RESULT_PATH)}\`.`,
    `- Temporary SQLite DB: \`${path.relative(ROOT, DB_PATH)}\`.`,
    '',
    '## Method',
    '',
    `- Wrote ${memoryCount} public-memory rows through \`MemoryWriter\`, with ${embeddingCount} embeddings.`,
    `- Retrieval used \`MemoryRetriever.retrieve({ scope: "public_eval", topK: ${TOP_K} })\`.`,
    '- Metrics are evidence-aware: a retrieved window/session counts as a hit when its metadata covers the gold turn.',
    `- Embeddings used a deterministic local hashed-token client so the eval is offline and reproducible.`,
    `- sqlite-vec available: ${vecAvailable ? 'yes' : 'no'}.`,
    '',
    '## Metrics',
    '',
    metricsTable(byDataset, metrics),
    '',
    '## Eval Lanes And Ablations',
    '',
    laneTable(allRuns),
    '',
    '### Per-Lane Hit@10 By Category',
    '',
    laneCategoryTable(allRuns),
    '',
    '> **Lane reading guide.** `configured_embedding_*` lanes use the real configured embedding model (e.g. bge-m3); `stable_hybrid_evidence_aware` uses a deterministic hashed-token client and is the CI gate.',
    '> - `deep_recall` widens the candidate pool (higher prefilter/merge multipliers) — it recovers weak-margin semantic hits (open_domain, multi_hop) at a modest latency cost. This is the reliable, deterministic lever.',
    '> - `llm_expansion` (forced) rewrites every query into lexical variants via an aux LLM (deepseek-v4-flash) and feeds them into the coverage + flat paths. It *can* bridge pure lexical gaps (e.g. "martial arts" → "kickboxing"), but the win is **stochastic**: across two identical runs single_hop measured 50% then 25%, because temperature-0.3 variants differ run-to-run and only sometimes emit the bridging term. It also dilutes borderline gold turns out of top-K (open_domain regressed to 0%), and its p95 is dominated by one synchronous LLM call per query (~5.6s on deepseek.com; ~42s on a flaky nvidia endpoint).',
    '> - `gated_expansion` only fires the LLM when the initial recall probe is weak (top similarity < min_score_trigger). At 0.3 it fired on 0/16 queries (every bge-m3 hybrid score clears it); at 0.55 it fired on ~1/16. Crucially the gate signal is `max(vector, FTS, term)` — so a precision miss like martial-arts, where the *words* "martial arts" match a non-answer turn via FTS, scores high and the gate skips it. A score gate detects "nothing matched", not "the wrong thing matched", so it cannot target lexical-precision misses.',
    '> - **Production takeaway:** gated expansion is a cheap, safe net for genuine low-recall queries (rare fires, no open_domain dilution, ~600ms typical p95) and is OFF by default (opt-in). It is *not* a reliable fix for single_hop lexical gaps — that needs a deterministic mechanism (synonym/lexical expansion on the FTS channel or a precision reranker), not an LLM score gate. Forcing expansion on every query is an upper-bound study, not a deployment posture.',
    '',
    '## Category Metrics',
    '',
    metricsTable(aggregateByCategory(results), metrics),
    '',
    '## Answer-Level Eval',
    '',
    '- Gold answers are stored in result JSON when public datasets provide them.',
    '- End-to-end answer scoring is opt-in (`--answer-judge` / `PUBLIC_MEMORY_EVAL_ANSWER_JUDGE=1`); generation sees only retrieved context, gold is used solely for grading.',
    ...answerReportLines(results),
    '',
    '## V11 Gate Metrics',
    '',
    `- Gate eligible cases: ${gateEligibleResults.length}/${results.length} (LoCoMo open-domain/adversarial excluded from gate, still reported above)`,
    `- Gate Hit@10: ${formatPercent(gateMetrics.hitAt10)}`,
    `- Precision@1: ${formatPercent(v11Report.precisionAt1)}`,
    `- Precision@3: ${formatPercent(v11Report.precisionAt3)}`,
    `- Forbidden leakage: ${formatPercent(v11Report.forbiddenLeakage)}`,
    `- Failed case IDs: ${v11Report.failedCaseIds.length === 0 ? 'none' : v11Report.failedCaseIds.join(', ')}`,
    '',
    '## Failed Hit@10 Cases',
    '',
    failed.length === 0
      ? 'None.'
      : failed.map(result => [
        `- ${result.id}: ${result.query}`,
        `  - expected: ${result.expectedPreviews.map(item => `${item.id} => ${item.content}`).join(' | ') || 'none'}`,
        `  - top retrieved: ${result.retrieved.slice(0, 5).map(item => `${item.id} (${item.kind}) => ${item.content}`).join(' | ') || 'none'}`,
      ].join('\n')).join('\n'),
    '',
    '## Reproduce',
    '',
    '```bash',
    'pnpm eval:memory:public',
    '```',
    '',
    'Optional knobs:',
    '',
    '```bash',
    'PUBLIC_MEMORY_EVAL_LOCOMO_CASES=20 PUBLIC_MEMORY_EVAL_LONGMEMEVAL_CASES=20 pnpm eval:memory:public',
    '```',
    '',
    '## Acceptance Notes',
    '',
    '- This first public batch validates persistence, sqlite-vec/fallback retrieval, ranking, and latency on real public memory-shaped data.',
    '- The deterministic embedding client is intentionally not a production embedding benchmark; it keeps this eval stable in CI and isolates memory pipeline behavior.',
  ];
  fs.writeFileSync(REPORT_PATH, `${lines.join('\n')}\n`, 'utf8');
}

function assertGate(run: EvalRunResult): void {
  const eligible = run.results.filter(isGateEligibleCase);
  const byDataset = aggregateByDataset(eligible);
  const overall = aggregate(eligible);
  const locomo = byDataset.locomo;
  const longMemEval = byDataset.longmemeval;
  const failures: string[] = [];
  if (!locomo || locomo.hitAt10 < 0.6) failures.push(`LoCoMo Hit@10 ${formatPercent(locomo?.hitAt10 ?? 0)} < 60.0%`);
  if (!longMemEval || longMemEval.hitAt10 < 0.9) failures.push(`LongMemEval Hit@10 ${formatPercent(longMemEval?.hitAt10 ?? 0)} < 90.0%`);
  if (overall.hitAt10 < 0.7) failures.push(`overall Hit@10 ${formatPercent(overall.hitAt10)} < 70.0%`);
  if (run.metrics.p95LatencyMs > 2_000) failures.push(`p95 ${formatMs(run.metrics.p95LatencyMs)} > 2000.0 ms`);
  if (failures.length > 0) {
    throw new Error(`Public memory eval gate failed:\n${failures.join('\n')}`);
  }
}

function isGateEligibleCase(result: CaseResult): boolean {
  return result.category !== 'locomo_open_domain' && result.category !== 'locomo_adversarial';
}

async function main(): Promise<void> {
  ensureDirs();
  const locomo = await buildLoCoMoFixture();
  const longMemEval = await buildLongMemEvalFixture();
  const fixture: BuiltFixture = {
    memories: [...locomo.memories, ...longMemEval.memories],
    cases: [...locomo.cases, ...longMemEval.cases],
    rawSnapshots: [...locomo.rawSnapshots, ...longMemEval.rawSnapshots],
  };
  writeFixture(fixture);
  const judge = createConfiguredJudge();
  const runs: EvalRunResult[] = [];
  const stableRun = await runEval(fixture, {
    lane: 'stable_hybrid_evidence_aware',
    embeddingClient: new DeterministicEmbeddingClient(),
    evidenceAware: true,
    writeArtifacts: true,
    judge,
  });
  runs.push(stableRun);

  if (RUN_ABLATION) {
    runs.push(await runEval(fixture, {
      lane: 'ablation_strict_id_scoring',
      embeddingClient: new DeterministicEmbeddingClient(),
      evidenceAware: false,
    }));
    runs.push(await runEval(fixture, {
      lane: 'ablation_text_only_evidence_aware',
      embeddingClient: new DeterministicEmbeddingClient(),
      textOnly: true,
      evidenceAware: true,
    }));
  }

  const configuredEmbeddingClient = createConfiguredEmbeddingClient();
  if (configuredEmbeddingClient) {
    // Default recall depth (baseline) for a clean before/after comparison.
    runs.push(await runEval(fixture, {
      lane: 'configured_embedding_hybrid',
      embeddingClient: configuredEmbeddingClient,
      evidenceAware: true,
    }));
    // Deep recall: surface weak-margin semantic hits into the candidate pool,
    // then let RRF + rerank pull the right ones up.
    runs.push(await runEval(fixture, {
      lane: 'configured_embedding_deep_recall',
      embeddingClient: createConfiguredEmbeddingClient()!,
      evidenceAware: true,
      recallConfig: {
        prefilterMultiplier: Number(process.env.PUBLIC_MEMORY_EVAL_RECALL_PREFILTER_MULT ?? 15),
        prefilterMin: Number(process.env.PUBLIC_MEMORY_EVAL_RECALL_PREFILTER_MIN ?? 60),
        mergeCandidateMultiplier: Number(process.env.PUBLIC_MEMORY_EVAL_RECALL_MERGE_MULT ?? 8),
      },
    }));
    // LLM query expansion (Direction 1): rewrite each query into lexical
    // variants via deepseek-v4-flash, feed them into both the coverage and flat
    // paths so weak-semantic single-hop cases (martial arts → kickboxing) get a
    // chance at an exact FTS match. Stacked on deep recall for the best base.
    const expansionConfig = createConfiguredExpansion();
    if (expansionConfig) {
      runs.push(await runEval(fixture, {
        lane: 'configured_embedding_llm_expansion',
        embeddingClient: createConfiguredEmbeddingClient()!,
        evidenceAware: true,
        recallConfig: {
          prefilterMultiplier: Number(process.env.PUBLIC_MEMORY_EVAL_RECALL_PREFILTER_MULT ?? 15),
          prefilterMin: Number(process.env.PUBLIC_MEMORY_EVAL_RECALL_PREFILTER_MIN ?? 60),
          mergeCandidateMultiplier: Number(process.env.PUBLIC_MEMORY_EVAL_RECALL_MERGE_MULT ?? 8),
        },
        expansionConfig,
      }));
    } else {
      runs.push({
        lane: 'configured_embedding_llm_expansion',
        results: [],
        metrics: aggregate([]),
        vecAvailable: false,
        memoryCount: 0,
        embeddingCount: 0,
        skippedReason: 'set --query-expansion (or PUBLIC_MEMORY_EVAL_QUERY_EXPANSION=1) + an expansion API key',
      });
    }
    // Production-realistic gated expansion: same model + deep recall, but the
    // LLM only fires when the probe's top similarity is below minScoreTrigger
    // (minQueryLength 15, not 10000). This measures the real trigger rate and
    // latency a deployment would see, vs the forced upper-bound lane above.
    const gatedExpansion = createConfiguredExpansion({ minQueryLength: 15 });
    if (gatedExpansion) {
      runs.push(await runEval(fixture, {
        lane: 'configured_embedding_gated_expansion',
        embeddingClient: createConfiguredEmbeddingClient()!,
        evidenceAware: true,
        recallConfig: {
          prefilterMultiplier: Number(process.env.PUBLIC_MEMORY_EVAL_RECALL_PREFILTER_MULT ?? 15),
          prefilterMin: Number(process.env.PUBLIC_MEMORY_EVAL_RECALL_PREFILTER_MIN ?? 60),
          mergeCandidateMultiplier: Number(process.env.PUBLIC_MEMORY_EVAL_RECALL_MERGE_MULT ?? 8),
        },
        expansionConfig: gatedExpansion,
      }));
    } else {
      runs.push({
        lane: 'configured_embedding_gated_expansion',
        results: [],
        metrics: aggregate([]),
        vecAvailable: false,
        memoryCount: 0,
        embeddingCount: 0,
        skippedReason: 'set --query-expansion (or PUBLIC_MEMORY_EVAL_QUERY_EXPANSION=1) + an expansion API key',
      });
    }
  } else {
    runs.push({
      lane: 'configured_embedding_hybrid',
      results: [],
      metrics: aggregate([]),
      vecAvailable: false,
      memoryCount: 0,
      embeddingCount: 0,
      skippedReason: 'set PUBLIC_MEMORY_EVAL_EMBEDDING_API_KEY, BASE_URL, MODEL, DIMENSION',
    });
  }

  fs.writeFileSync(RESULT_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    topK: TOP_K,
    primaryLane: stableRun.lane,
    vecAvailable: stableRun.vecAvailable,
    memoryCount: stableRun.memoryCount,
    embeddingCount: stableRun.embeddingCount,
    metrics: stableRun.metrics,
    metricsByDataset: aggregateByDataset(stableRun.results),
    answerAccuracy: aggregateAnswerAccuracy(stableRun.results),
    answerAccuracyByCategory: answerAccuracyByCategory(stableRun.results),
    results: stableRun.results,
    runs: runs.map(run => ({
      lane: run.lane,
      skippedReason: run.skippedReason,
      metrics: run.metrics,
      metricsByDataset: aggregateByDataset(run.results),
      vecAvailable: run.vecAvailable,
      memoryCount: run.memoryCount,
      embeddingCount: run.embeddingCount,
      results: run.results,
    })),
  }, null, 2), 'utf8');
  writeReport(fixture, stableRun, runs);
  if (RUN_GATE) assertGate(stableRun);
  console.log(`Public memory eval complete: ${REPORT_PATH}`);
  console.log(metricsTable(aggregateByDataset(stableRun.results), stableRun.metrics));
  console.log('');
  console.log(laneTable(runs));
  const answerAcc = aggregateAnswerAccuracy(stableRun.results);
  if (answerAcc.judged > 0) {
    console.log('');
    console.log('Answer accuracy (judged):');
    console.log(answerAccuracyTable(answerAccuracyByCategory(stableRun.results), answerAcc));
  } else if (RUN_ANSWER_JUDGE) {
    console.log('');
    console.log('Answer judging requested but no cases were judged (no judge model configured).');
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
