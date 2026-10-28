/**
 * KnowledgeCurator — the nightly curation job (plan §6 K2-5, §9.4).
 *
 * Turns memories into knowledge pages. It is one of the three curation entry
 * points (`DreamCycle`'s `knowledge_curate` phase, `/knowledge curate`, and the
 * share flow) and it deliberately owns no write logic of its own: every page
 * goes through `KnowledgeService.create/update` with
 * `{ actor: 'system', enforceAdmission: true }`, so admission, provenance,
 * version checking, FTS and the log row have exactly one implementation.
 *
 * ## What one run does
 *
 *   1. `since` = the start of the last *successful* `dreamcycle_knowledge_curate`
 *      run (or one night back when there is none). A night the phone slept
 *      through is not a lost night — the window simply spans it (§9.4 rule 3).
 *   2. Read the `fact`/`summary`/`preference` memories created since then
 *      (bounded, active, above `min_memory_confidence`).
 *   3. One aux-LLM call groups them into page candidates (a nameable subject
 *      plus the memory ids that support it). Grouping is LLM work because the
 *      deterministic `extractEntities` only admits person/org mentions with
 *      name context — it cannot name a topic, so grouping on it would never
 *      admit anything.
 *   4. Per group: gather the whole supporting source set (the group's own ids
 *      plus every active memory that mentions the subject), check the admission
 *      rules, then one aux-LLM call writes the page body, then one service
 *      write.
 *
 * ## The three rules (§6 K2-3.2), and who enforces them
 *
 * A page needs at least two of: (1) a nameable subject, (2) ≥ `requireSources`
 * independent sources, (3) an explicit user request. Rule 1 is not optional in
 * practice — a page with no nameable subject has no title and no slug — so the
 * majority reduces to `rule1 && (rule2 || rule3)`, which is what
 * {@link evaluateAdmission} checks. That check is a **cost gate, not the
 * authority**: the aux-LLM call is the expensive step on a phone, and a group
 * that cannot pass must not spend one. The service re-checks with
 * `enforceAdmission: true` and its rejection wins.
 *
 * ## Constraints this file is built around (§9.4)
 *
 *   - **One page per transaction.** The service owns the transaction; this file
 *     never opens one, so a curation run never holds the write lock that IM
 *     replies need (§9.4 rule 2).
 *   - **Bounded work.** Candidate scan and per-group source scan are both
 *     `LIMIT`ed, `max_pages_per_run` caps the writes, and the `AbortSignal` is
 *     checked between pages — the phase timeout can stop the run at a page
 *     boundary, never inside a write.
 *   - **Catch-up capable.** Idempotency comes from the page identity: the slug
 *     is derived deterministically from the subject, so the same topic on a
 *     re-run UPDATEs that page (with `expectedVersion`) instead of creating a
 *     second one (§9.4 rule 3).
 *
 * ## What it refuses to guess
 *
 * `page_type` is never taken from the model. `knowledge_pages` is unique on
 * `(page_type, slug)`, so a model that names the same subject `topic` tonight
 * and `entity` tomorrow would create a second page — the exact duplicate the
 * idempotency rule forbids. It is derived instead: a group whose sources are
 * all project-scoped becomes a `project` page, everything else a `topic` page.
 */

import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { auxLLMCall } from '../aux-llm-client.js';
import type { AuxLLMCallOptions, AuxModelConfig } from '../aux-llm-client.js';
import { slugifySegment } from '../../graph-export/slug.js';
import type {
  KnowledgeService,
  KnowledgeWriteOptions,
  KnowledgeWriteRejection,
  KnowledgeWriteResult,
} from './service-contract.js';
import type {
  CreateKnowledgePageInput,
  KnowledgeSourceInput,
  PageType,
  UpdateKnowledgePageInput,
} from './types.js';

// ── Config ──────────────────────────────────────────────────────────────

/** `knowledge.curate.mode` — the frequency gate, not a quality gate. */
export type CurateMode = 'off' | 'manual' | 'nightly';

/**
 * Who asked for this run. `manual` is an explicit user request, which is
 * admission rule 3 — that is why it is derived from the trigger rather than
 * passed as a separate flag.
 */
export type CurateTrigger = 'nightly' | 'manual';

export interface KnowledgeCurateConfig {
  /** `knowledge.enabled` — the layer switch; `false` makes the run inert. */
  enabled: boolean;
  mode: CurateMode;
  /** `curate.shadow` — new pages land `pending` instead of `active`. */
  shadow: boolean;
  /** `curate.max_pages_per_run`; `0` is equivalent to `mode: off`. */
  maxPagesPerRun: number;
  /** `curate.require_sources` — admission rule 2 threshold, clamped to ≥ 1. */
  requireSources: number;
  /** `curate.min_memory_confidence` — memories below this never seed a page. */
  minMemoryConfidence: number;
  /** `curate.model_ref` resolved to an aux config; unset = `memory_aux_models`. */
  auxConfig?: AuxModelConfig;
}

// ── Report ──────────────────────────────────────────────────────────────

export type CurateSkipReason =
  'disabled' | 'mode_manual' | 'no_aux_model' | 'no_candidates' | 'no_groups';

export interface CurateRunReport {
  /** Set when the run did nothing; absent on a run that reached the write loop. */
  skipped?: CurateSkipReason;
  /** Window start (epoch ms) used to select candidate memories. */
  since: number;
  candidates: number;
  groups: number;
  created: number;
  updated: number;
  /** Refusals by reason: `no_subject`, `not_recurrent`, `not_requested`, `version_conflict`, … */
  rejected: Record<string, number>;
  /** Groups whose aux-LLM call, parse or write threw. */
  failed: number;
  /** True when an `AbortSignal` stopped the run at a page boundary. */
  aborted: boolean;
}

export interface CurateRunOptions {
  /** Default `'nightly'` (the `DreamCycle` phase). */
  trigger?: CurateTrigger;
  /** Checked between pages — never inside a write. */
  signal?: AbortSignal;
}

export interface KnowledgeCurateDeps {
  db: Database.Database;
  knowledgeService: KnowledgeService;
  logger: Logger;
  config: KnowledgeCurateConfig;
  /**
   * Test seam: replaces the aux-LLM completion. Production omits it, and the
   * curator then calls `auxLLMCall(config.auxConfig)` — the same completion path
   * `DreamCycle.synthesize` reaches through `mergeMemory`, so there is no second
   * LLM client.
   */
  callLLM?: (options: AuxLLMCallOptions) => Promise<string>;
}

// ── Constants ───────────────────────────────────────────────────────────

/** `maintenance_runs.job_name` of the phase this job runs under. */
const CURATE_JOB_NAME = 'dreamcycle_knowledge_curate';

/** Recorded as the log/`reason` of every page this job writes. */
const CURATE_REASON = 'knowledge_curate';

/**
 * Which memories may seed a page. `scene`/`persona`/`hygiene_checkpoint` rows
 * are derived artifacts, not raw knowledge, and curating them would let the
 * curators feed on their own output.
 */
const CANDIDATE_KINDS = ['fact', 'summary', 'preference'] as const;

/** Bounded reads: a phone must not scan `memories` (§9.4). */
const CANDIDATE_LIMIT = 60;
const MAX_SOURCES_PER_PAGE = 12;

/** A first run (no successful predecessor) looks back one night, not the whole table. */
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** Longer "subjects" are sentences, not names. */
const MAX_SUBJECT_CHARS = 80;

/** Per-memory prompt budget; the LLM only needs the gist to group and summarise. */
const MAX_MEMORY_CHARS = 400;

// ── Row shapes ──────────────────────────────────────────────────────────

interface CandidateMemory {
  id: string;
  content: string;
  kind: string;
  scope: string;
  scope_key: string;
  confidence: number;
}

interface SourceMemory {
  id: string;
  content: string;
  scope: string;
  confidence: number;
}

export interface CurateGroup {
  /** Nameable subject as the model named it, trimmed. */
  subject: string;
  /** Memory ids the model cited, filtered to ids it was actually shown. */
  memoryIds: string[];
}

export interface CuratedPage {
  title: string;
  content: string;
  tags: string[];
  aliases: string[];
}

// ── Admission ───────────────────────────────────────────────────────────

/** The three admission facts, as only the curator can observe them. */
export interface AdmissionFacts {
  /** Nameable subject, trimmed; `''` when the group named nothing usable. */
  subject: string;
  /** Distinct memory ids backing the group (recurrence). */
  sourceCount: number;
  /** The user asked for this page in so many words (rule 3). */
  explicitRequest: boolean;
}

type AdmissionRejection = Extract<KnowledgeWriteRejection, { code: 'admission_rejected' }>;

/**
 * The admission majority (§6 K2-3.2), as a pre-flight check.
 *
 * Returns `null` when the group may be attempted, or the refusal that the
 * service would return anyway. Rules 1+2, 1+3 and 2+3 pass; only 1+2 is
 * reachable in practice because rule 1 is what a page can be *named* by.
 *
 * The service is the authority (`enforceAdmission: true`); this exists so a
 * group that cannot pass never costs an aux-LLM call.
 */
export function evaluateAdmission(
  facts: AdmissionFacts,
  requireSources: number,
): AdmissionRejection | null {
  if (!facts.subject.trim()) {
    return {
      code: 'admission_rejected',
      reason: 'no_subject',
      detail: 'the group has no nameable subject (a page needs a title and a slug)',
    };
  }
  const threshold = Math.max(1, requireSources);
  if (facts.sourceCount < threshold && !facts.explicitRequest) {
    return {
      code: 'admission_rejected',
      reason: 'not_recurrent',
      detail: `${facts.sourceCount} independent source(s) < ${threshold} and the user did not ask for this page`,
    };
  }
  return null;
}

// ── Prompt parsing ──────────────────────────────────────────────────────

const GROUPING_SYSTEM_PROMPT = [
  'You group durable memories into knowledge-page candidates.',
  'A candidate needs a nameable subject: one specific tool, project, product, person, organization or topic.',
  'A sentence, a preference with no subject ("the user prefers concise answers") or an unnamed thing is NOT a subject.',
  'Group memories that are about the same subject together. Never invent memory ids.',
  'Output ONLY JSON, no prose:',
  '[{"subject":"<nameable subject>","memoryIds":["<id>"]}]',
  'If nothing qualifies, output [].',
].join('\n');

const PAGE_SYSTEM_PROMPT = [
  'You write one knowledge page about a subject, using only the cited memories.',
  'Rules:',
  '- Use only what the memories support. If they are thin, write a short page; never invent facts, numbers, names or dates.',
  '- Markdown body, at most 1200 characters, no top-level heading (the title is stored separately).',
  '- Write in the language the memories are written in.',
  'Output ONLY JSON, no prose:',
  '{"title":"<page title>","content":"<markdown body>","tags":["<tag>"],"aliases":["<other name for the subject>"]}',
].join('\n');

/** Strip ``` fences and surrounding prose, then parse the first JSON value. */
function parseJsonValue(raw: string): unknown {
  const withoutFences = raw.replace(/```(?:json)?/gi, ' ');
  const trimmed = withoutFences.trim();
  const start = trimmed.search(/[[{]/);
  const end = Math.max(trimmed.lastIndexOf(']'), trimmed.lastIndexOf('}'));
  const candidates = [trimmed];
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next, narrower candidate.
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    out.push(trimmed);
  }
  return out;
}

/**
 * Read the grouping call's answer.
 *
 * Ids the model was not shown are dropped rather than trusted — a hallucinated
 * id would otherwise become a source the service has to reject, and a group
 * left with no real source is not a candidate at all.
 *
 * Groups are deduplicated on the *slug*, not on the raw subject: `Power Query`
 * and `Power-Query` are the same page identity, and writing both in one run
 * would spend a second aux-LLM call to overwrite what the first one wrote.
 */
export function parseGroupingResponse(raw: string, knownIds: ReadonlySet<string>): CurateGroup[] {
  const value = parseJsonValue(raw);
  const list = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.groups)
      ? value.groups
      : [];

  const seenSubjects = new Set<string>();
  const groups: CurateGroup[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const subject = typeof entry.subject === 'string' ? entry.subject.trim() : '';
    if (!subject || subject.length > MAX_SUBJECT_CHARS) continue;
    const subjectKey = slugifySegment(subject) || subject.toLowerCase();
    if (seenSubjects.has(subjectKey)) continue;

    const rawIds = Array.isArray(entry.memoryIds)
      ? entry.memoryIds
      : Array.isArray(entry.memory_ids)
        ? entry.memory_ids
        : [];
    const memoryIds = [
      ...new Set(rawIds.filter((id): id is string => typeof id === 'string' && knownIds.has(id))),
    ];
    if (memoryIds.length === 0) continue;

    seenSubjects.add(subjectKey);
    groups.push({ subject, memoryIds });
  }
  return groups;
}

/** Read the page-writing call's answer; `null` when it cannot be used. */
export function parsePageResponse(raw: string): CuratedPage | null {
  const value = parseJsonValue(raw);
  if (!isRecord(value)) return null;
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const content = typeof value.content === 'string' ? value.content.trim() : '';
  if (!title || !content) return null;
  return {
    title,
    content,
    tags: readStringArray(value.tags),
    aliases: readStringArray(value.aliases),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** `LIKE` treats `%`, `_` and the escape char itself as pattern syntax. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function formatMemoryLines(rows: ReadonlyArray<{ id: string; content: string }>): string {
  return rows.map((row) => `- [${row.id}] ${truncate(row.content, MAX_MEMORY_CHARS)}`).join('\n');
}

// ── Curator ─────────────────────────────────────────────────────────────

export class KnowledgeCurator {
  constructor(private readonly deps: KnowledgeCurateDeps) {}

  private get logger(): Logger {
    return this.deps.logger;
  }

  private get config(): KnowledgeCurateConfig {
    return this.deps.config;
  }

  /**
   * Run one curation pass.
   *
   * Never opens a transaction (the service does, per page) and never writes a
   * page it could not parse — a failed group is logged and skipped, because a
   * half-written page is worse than no page (§10 risk table).
   *
   * @throws when the grouping call fails. That is a failed run, not an empty
   *   one, and the caller's per-phase bookkeeping should record it.
   */
  async run(options: CurateRunOptions = {}): Promise<CurateRunReport> {
    const trigger: CurateTrigger = options.trigger ?? 'nightly';
    const report: CurateRunReport = {
      since: 0,
      candidates: 0,
      groups: 0,
      created: 0,
      updated: 0,
      rejected: {},
      failed: 0,
      aborted: false,
    };

    const skip = this.skipReason(trigger);
    if (skip) {
      report.skipped = skip;
      this.logger.debug({ trigger, skip }, 'knowledge curate skipped');
      return report;
    }

    // `skipReason` already proved a caller exists.
    const callLLM = this.resolveCaller() as (options: AuxLLMCallOptions) => Promise<string>;

    report.since = this.windowStart();
    if (options.signal?.aborted) {
      report.aborted = true;
      return report;
    }

    const candidates = this.gatherCandidates(report.since);
    report.candidates = candidates.length;
    if (candidates.length === 0) {
      report.skipped = 'no_candidates';
      this.logger.debug({ since: report.since }, 'knowledge curate: no candidate memories');
      return report;
    }

    const groups = parseGroupingResponse(
      await callLLM({
        systemPrompt: GROUPING_SYSTEM_PROMPT,
        userPrompt: formatMemoryLines(candidates),
        temperature: 0.1,
        maxTokens: 800,
        logger: this.logger,
      }),
      new Set(candidates.map((memory) => memory.id)),
    );
    report.groups = groups.length;
    if (groups.length === 0) {
      report.skipped = 'no_groups';
      this.logger.debug({ candidates: candidates.length }, 'knowledge curate: no page candidates');
      return report;
    }

    let lastError: unknown = null;
    for (const group of groups) {
      // Abort is honoured only here: a page write is atomic inside the service,
      // so there is no safe point to stop between "half a page" and "no page".
      if (options.signal?.aborted) {
        report.aborted = true;
        break;
      }
      if (report.created + report.updated >= this.config.maxPagesPerRun) break;

      const error = await this.curateGroup(group, trigger, callLLM, report);
      if (error) lastError = error;
      if (options.signal?.aborted) {
        report.aborted = true;
        break;
      }
    }

    this.logger.info(
      {
        trigger,
        since: report.since,
        candidates: report.candidates,
        groups: report.groups,
        created: report.created,
        updated: report.updated,
        rejected: report.rejected,
        failed: report.failed,
        aborted: report.aborted,
      },
      'knowledge curate run finished',
    );

    // Every call failed and nothing was written: report the run as failed rather
    // than as a quiet no-op, so the phase shows up in maintenance_runs.
    if (lastError && report.created + report.updated === 0 && report.failed > 0) {
      throw lastError;
    }
    return report;
  }

  /** Why this run must not start, or `null`. */
  private skipReason(trigger: CurateTrigger): CurateSkipReason | null {
    if (!this.config.enabled) return 'disabled';
    if (this.config.mode === 'off') return 'disabled';
    // `manual` keeps the nightly phase from curating behind the user's back.
    if (trigger === 'nightly' && this.config.mode !== 'nightly') return 'mode_manual';
    if (this.config.maxPagesPerRun <= 0) return 'disabled';
    if (!this.resolveCaller()) return 'no_aux_model';
    return null;
  }

  /** The aux-LLM completion, or `null` when no model is configured. */
  private resolveCaller(): ((options: AuxLLMCallOptions) => Promise<string>) | null {
    if (this.deps.callLLM) return this.deps.callLLM;
    const auxConfig = this.config.auxConfig;
    const configured = Boolean(auxConfig?.modelRef || (auxConfig?.fallbackRefs?.length ?? 0) > 0);
    if (!auxConfig || !configured) return null;
    return (options) => auxLLMCall(auxConfig, options);
  }

  /**
   * Start of the curation window.
   *
   * The last *successful* run's start, so a missed night is caught up rather
   * than dropped (§9.4 rule 3); the current run's own row is still `running`, so
   * it cannot select itself. A first run looks back one night instead of
   * scanning the whole table — historical backfill is a manual CLI concern, not
   * a nightly one (§9.4 rule 1).
   */
  private windowStart(): number {
    const row = this.db
      .prepare(
        `SELECT CAST(started_at AS INTEGER) AS started_at
           FROM maintenance_runs
          WHERE job_name = ? AND status = 'success'
          ORDER BY CAST(started_at AS INTEGER) DESC
          LIMIT 1`,
      )
      .get(CURATE_JOB_NAME) as { started_at: number | null } | undefined;
    const startedAt = row?.started_at;
    if (typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt > 0) {
      return startedAt;
    }
    return Date.now() - FIRST_RUN_LOOKBACK_MS;
  }

  private get db(): Database.Database {
    return this.deps.db;
  }

  /** Active memories of a curatable kind created inside the window. */
  private gatherCandidates(since: number): CandidateMemory[] {
    const kinds = [...CANDIDATE_KINDS];
    const placeholders = kinds.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT id, content, kind, scope, scope_key, confidence
           FROM memories
          WHERE status = 'active'
            AND kind IN (${placeholders})
            AND confidence >= ?
            AND CAST(created_at AS INTEGER) >= ?
          ORDER BY CAST(created_at AS INTEGER) ASC
          LIMIT ?`,
      )
      .all(...kinds, this.config.minMemoryConfidence, since, CANDIDATE_LIMIT) as CandidateMemory[];
  }

  /**
   * The whole supporting source set for one subject: the group's own ids plus
   * every active memory that mentions the subject.
   *
   * The cross-window half is what makes admission rule 2 (recurrence) reachable
   * in steady state — with a one-night window, every topic would otherwise look
   * like a single mention forever.
   */
  private gatherSources(subject: string, groupIds: readonly string[]): SourceMemory[] {
    const kinds = [...CANDIDATE_KINDS];
    const placeholders = kinds.map(() => '?').join(',');
    const idPlaceholders = groupIds.map(() => '?').join(',');
    const idClause = groupIds.length > 0 ? ` OR id IN (${idPlaceholders})` : '';
    return this.db
      .prepare(
        `SELECT id, content, scope, confidence
           FROM memories
          WHERE status = 'active'
            AND kind IN (${placeholders})
            AND confidence >= ?
            AND (content LIKE ? ESCAPE '\\'${idClause})
          ORDER BY CAST(created_at AS INTEGER) ASC
          LIMIT ?`,
      )
      .all(
        ...kinds,
        this.config.minMemoryConfidence,
        `%${escapeLike(subject)}%`,
        ...groupIds,
        MAX_SOURCES_PER_PAGE,
      ) as SourceMemory[];
  }

  /**
   * Curate one group. Returns the error that made the group fail, or `null`.
   */
  private async curateGroup(
    group: CurateGroup,
    trigger: CurateTrigger,
    callLLM: (options: AuxLLMCallOptions) => Promise<string>,
    report: CurateRunReport,
  ): Promise<unknown> {
    const subject = group.subject.trim();
    // A subject that slugifies to nothing cannot identify a page; treat it as
    // unnamed so rule 1 answers for it (the service would refuse it too).
    const slug = slugifySegment(subject);
    const sources = this.gatherSources(subject, group.memoryIds);

    const rejection = evaluateAdmission(
      {
        subject: slug ? subject : '',
        sourceCount: sources.length,
        explicitRequest: trigger === 'manual',
      },
      this.config.requireSources,
    );
    if (rejection) {
      this.countRejection(report, rejection.reason);
      this.logger.debug(
        { subject, reason: rejection.reason, detail: rejection.detail },
        'knowledge curate: group rejected before the page call',
      );
      return null;
    }

    // Deterministic, never model-chosen: `(page_type, slug)` is the page's
    // identity, so a model flip between page types would create a duplicate.
    const pageType: PageType = sources.every((source) => source.scope === 'project')
      ? 'project'
      : 'topic';

    let raw: string;
    try {
      raw = await callLLM({
        systemPrompt: PAGE_SYSTEM_PROMPT,
        userPrompt: `SUBJECT: ${subject}\n\nMEMORIES:\n${formatMemoryLines(sources)}`,
        temperature: 0.2,
        maxTokens: 1200,
        logger: this.logger,
      });
    } catch (err) {
      report.failed++;
      this.logger.warn({ subject, err: errorMessage(err) }, 'knowledge curate: page call failed');
      return err;
    }

    const page = parsePageResponse(raw);
    if (!page) {
      report.failed++;
      this.logger.warn(
        { subject, response: truncate(raw, 200) },
        'knowledge curate: unusable page response, skipping group',
      );
      return null;
    }

    const sourceInputs: KnowledgeSourceInput[] = sources.map((source) => ({
      kind: 'memory',
      id: source.id,
    }));
    const confidence = Math.round(Math.min(...sources.map((s) => s.confidence)) * 100) / 100;
    const writeOptions: KnowledgeWriteOptions = { actor: 'system', enforceAdmission: true };

    let result: KnowledgeWriteResult;
    try {
      const existing = this.deps.knowledgeService.get({ slug, pageType });
      if (existing) {
        const update: UpdateKnowledgePageInput = {
          title: page.title,
          content: page.content,
          tags: page.tags,
          aliases: page.aliases,
          confidence,
          expectedVersion: existing.page.version,
          sources: sourceInputs,
          reason: CURATE_REASON,
        };
        result = this.deps.knowledgeService.update({ slug, pageType }, update, writeOptions);
      } else {
        const create: CreateKnowledgePageInput = {
          pageType,
          slug,
          title: page.title,
          content: page.content,
          tags: page.tags,
          aliases: page.aliases,
          confidence,
          // Shadow mode is expressed here, once: the page is written pending and
          // never flipped afterwards (approval is `setStatus`).
          status: this.config.shadow ? 'pending' : 'active',
          sources: sourceInputs,
          reason: CURATE_REASON,
        };
        result = this.deps.knowledgeService.create(create, writeOptions);
      }
    } catch (err) {
      report.failed++;
      this.logger.warn({ subject, err: errorMessage(err) }, 'knowledge curate: page write failed');
      return err;
    }

    if (!result.ok) {
      const reason = result.code === 'admission_rejected' ? result.reason : result.code;
      this.countRejection(report, reason);
      this.logger.debug(
        { subject, code: result.code, reason },
        'knowledge curate: write refused by the service',
      );
      return null;
    }

    if (result.created) report.created++;
    else report.updated++;
    this.logger.debug(
      { subject, slug, pageType, created: result.created, version: result.version },
      'knowledge curate: page written',
    );
    return null;
  }

  private countRejection(report: CurateRunReport, reason: string): void {
    report.rejected[reason] = (report.rejected[reason] ?? 0) + 1;
  }
}
