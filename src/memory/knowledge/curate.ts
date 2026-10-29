/**
 * KnowledgeCurator — the curation engine (plan §6 K2-5, §9.4).
 *
 * Turns memories into knowledge pages. It is the single engine behind all three
 * curation entry points — `DreamCycle`'s `knowledge_curate` phase ({@link run}),
 * `/knowledge curate` (also {@link run}, with the `manual` trigger) and a shared
 * message ({@link KnowledgeCurator.curateMessage}, reached both by `/knowledge
 * share` and by the automatic trigger in `share-trigger.ts`; only their trigger
 * label differs) — and it
 * deliberately owns no write logic of its own: every page goes through
 * `KnowledgeService.create/update` with `{ actor: 'system', enforceAdmission:
 * true }`, so admission, provenance, version checking, FTS and the log row have
 * exactly one implementation.
 *
 * ## The share flow
 *
 * A shared link or attachment is a *message*, not a memory, so it enters through
 * the message id: one message in, at most one page out, written by the same
 * grouping → page → `writeGroups` path as the nightly pass. The shared message is
 * attached as an extra `message` citation; it never gets a writer of its own.
 * The user asked for that page, which is admission rule 3 — passed down as
 * `explicitRequest`, so one source is enough and shadow mode still applies.
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
 *      write. That call is also shown the address and title of the existing
 *      active pages (bounded, bodies never), because a page graph needs a
 *      producer: `knowledge_links` is parsed from the body, so a model that
 *      cannot address a slug writes no edge — it invents one instead.
 *
 * ## The three rules (§6 K2-3.2), and who enforces them
 *
 * A page needs at least two of: (1) a nameable subject, (2) ≥ `requireSources`
 * independent sources, (3) an explicit user request. "Independent" is counted per
 * *conversation*, not per row ({@link countIndependentSources}): the same session
 * summarised twice is one attestation of the subject, and counting the rows would
 * let one chat satisfy recurrence with its own restatement. Rule 1 is not optional in
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
 * ## Which conversation the page belongs to
 *
 * Every write carries `KnowledgeWriteOptions.scope` (migration-v22) — the
 * conversation that triggered the run. `/knowledge curate` and a shared message
 * pass their chat's scope, so a page distilled from one group chat is readable
 * there and nowhere else; the nightly phase has no chat and writes `global`.
 * The dedupe lookup and the existing-page list take the same scope, so a re-run
 * in one chat updates *that* chat's page and is never offered another chat's
 * page as a link target.
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
import { parseEpochMs } from '../../shared/timestamp.js';
import type {
  CreateKnowledgePageInput,
  KnowledgeSourceInput,
  KnowledgeSourceKind,
  PageType,
  UpdateKnowledgePageInput,
} from './types.js';
import { isPageType } from './types.js';
import { scopeSql } from './scope.js';

// ── Config ──────────────────────────────────────────────────────────────

/** `knowledge.curate.mode` — the frequency gate, not a quality gate. */
export type CurateMode = 'off' | 'manual' | 'nightly';

/**
 * Who asked for this run.
 *
 * `nightly` is the `DreamCycle` phase — nobody asked, so admission rule 3 does not
 * apply. `manual` is a typed command (`/knowledge curate`, `/knowledge share`) and
 * `share` is a link arriving in a user message (see `share-trigger.ts`); both are
 * an explicit request, so the two are kept apart only for telemetry and logs —
 * telling an automatic share from a typed command is the difference between "the
 * feature works" and "someone is exercising it".
 */
export type CurateTrigger = 'nightly' | 'manual' | 'share';

/**
 * Whether the trigger is a user request, i.e. admission rule 3.
 *
 * Everything except the nightly phase is: `manual` because someone typed it, and
 * `share` because the message *is* the thing they chose to share. This is derived
 * from the trigger rather than passed as a separate flag so the two cannot
 * disagree.
 */
function isExplicitRequest(trigger: CurateTrigger): boolean {
  return trigger !== 'nightly';
}

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
  | 'disabled'
  | 'mode_manual'
  | 'no_aux_model'
  | 'no_candidates'
  | 'no_groups'
  /** The shared reference (`curateMessage`) matched no user message. */
  | 'message_not_found';

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
  /**
   * The conversation this run writes into — `KnowledgeWriteOptions.scope`.
   *
   * Omitted means `global`, which is the nightly phase: it has no chat. The
   * channel entry points pass `scopeFromContext(...)`, so a page distilled from a
   * group chat is readable in that chat and nowhere else, and the page lookup
   * before the write is addressed the same way.
   */
  scope?: string;
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
  callLLM?: AuxCaller;
}

/** One aux-LLM completion; the curated prompts are the only callers. */
type AuxCaller = (options: AuxLLMCallOptions) => Promise<string>;

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

/**
 * How many existing pages the page call is shown as link targets.
 *
 * Bounded like every other read in this file: the list is only there so the
 * model can address a page that already exists, and a phone must not carry the
 * whole page table into one prompt.
 */
const MAX_EXISTING_PAGE_HINTS = 40;

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
  scope_key: string;
  confidence: number;
}

export interface CurateGroup {
  /** Nameable subject as the model named it, trimmed. */
  subject: string;
  /** Memory ids the model cited, filtered to ids it was actually shown. */
  memoryIds: string[];
}

/**
 * One thing a page cites and the page-writing call reads: a memory row, or (share
 * flow) the message the user shared.
 *
 * `scope`/`confidence` are memory-only; a message carries neither, and both are
 * nullable so a citation kind cannot quietly inherit a memory's trust score.
 *
 * `conversationKey` is the conversation that attested the subject — for a memory,
 * `memories.scope_key`, which is the session key both `writeSummary()` and
 * `writePreference()` store. It is `null` for a message citation, which carries no
 * conversation of its own. It is deliberately not exposed as a citation: the page
 * still cites `kind:id` rows, and this field exists for the recurrence count.
 */
export interface CurateSource {
  kind: KnowledgeSourceKind;
  id: string;
  content: string;
  scope: string | null;
  confidence: number | null;
  conversationKey: string | null;
}

export interface CuratedPage {
  title: string;
  content: string;
  tags: string[];
  aliases: string[];
}

/**
 * One existing page the page call may link to: the address only, never its body.
 *
 * The body is not shown on purpose — the memories are the page's only source, and
 * pasting another page's text would smuggle in evidence the page does not cite.
 */
export interface ExistingPageHint {
  pageType: PageType;
  slug: string;
  title: string;
}

// ── Admission ───────────────────────────────────────────────────────────

/** The three admission facts, as only the curator can observe them. */
export interface AdmissionFacts {
  /** Nameable subject, trimmed; `''` when the group named nothing usable. */
  subject: string;
  /**
   * Distinct conversations backing the group (recurrence), not distinct rows —
   * see {@link countIndependentSources}.
   */
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
  '- When the body mentions a topic that the EXISTING PAGES list contains, write its link exactly as `[[page_type/slug]]` (e.g. `[[topic/power-query]]`); a target that is not on that list must be written as plain text — never guess a slug, and never link the subject to itself.',
  'Output ONLY JSON, no prose:',
  '{"title":"<page title>","content":"<markdown body>","tags":["<tag>"],"aliases":["<other name for the subject>"]}',
].join('\n');

/**
 * The share flow's grouping input: the same candidate line format as a memory
 * batch, prefixed so the model knows the row is a message that was shared rather
 * than a durable memory it may treat as already-compressed.
 */
const MESSAGE_GROUPING_PREFIX =
  'The user shared the message below and asked for it to become a knowledge page.';

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

/**
 * The link-target list of the page call.
 *
 * `(none)` rather than an omitted section: the rule in `PAGE_SYSTEM_PROMPT` that
 * forbids inventing a slug has to apply the same way whether or not this vault
 * already has pages, and a missing list is how a model starts guessing one.
 */
function formatPageHints(hints: readonly ExistingPageHint[]): string {
  if (hints.length === 0) return '(none)';
  return hints
    .map(
      (hint) => `- [[${hint.pageType}/${hint.slug}]] — ${truncate(hint.title, MAX_SUBJECT_CHARS)}`,
    )
    .join('\n');
}

/**
 * The group's memory sources plus, on the share flow, the message that was
 * shared.
 *
 * `extra` comes first because it is the reason the page exists: the per-page cap
 * must never be what drops the shared message's provenance. Deduplication is by
 * `kind:id` — the same memory mentioned twice is one citation (the service
 * dedupes again on its side).
 */
function mergeSources(
  extra: readonly CurateSource[],
  memories: readonly CurateSource[],
): CurateSource[] {
  const seen = new Set<string>();
  const out: CurateSource[] = [];
  for (const source of [...extra, ...memories]) {
    const key = `${source.kind}:${source.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
  }
  return out.slice(0, MAX_SOURCES_PER_PAGE);
}

/**
 * How many *conversations* attest this group — the number admission rule 2 counts.
 *
 * A source is a conversation, not a row: summaries are written every
 * `summarize_interval` messages, so one chat restating a subject produces several
 * `summary`/`preference` memories that all mention it. Counting rows let that one
 * chat satisfy `require_sources: 2` with its own restatement, which is the exact
 * inversion of the rule — recurrence is meant to measure "who attested this", and
 * a single session cannot be a second witness to itself. Two genuinely different
 * facts from one session are still one source for the same reason.
 *
 * A citation with no conversation (`scope_key` missing, or a shared message, which
 * has none) counts as its own source: it is not evidence of a shared origin, and
 * folding unrelated rows together would refuse real recurrence instead.
 */
export function countIndependentSources(sources: readonly CurateSource[]): number {
  const seen = new Set<string>();
  for (const source of sources) {
    const conversation = source.conversationKey?.trim();
    seen.add(conversation ? `conversation:${conversation}` : `${source.kind}:${source.id}`);
  }
  return seen.size;
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
   * The gates a caller outside this file has to respect.
   *
   * The share trigger (`share-trigger.ts`) reads `enabled`/`mode` to refuse a
   * message *before* spending a call, and `maxPagesPerRun` to bound one burst —
   * from here rather than from a second copy of the config, because these are the
   * values this curator enforces itself. A copy anywhere else would drift the
   * first time a setting changes. This is not a new switch: it is the same
   * `knowledge.enabled` / `curate.mode` / `curate.max_pages_per_run` triple.
   */
  get limits(): { enabled: boolean; mode: CurateMode; maxPagesPerRun: number } {
    return {
      enabled: this.config.enabled,
      mode: this.config.mode,
      maxPagesPerRun: this.config.maxPagesPerRun,
    };
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
    const callLLM = this.resolveCaller() as AuxCaller;

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

    return this.writeGroups(groups, trigger, callLLM, report, {
      signal: options.signal,
      scope: options.scope,
    });
  }

  /**
   * Curate one shared message — the share entry point (`/knowledge share`).
   *
   * The whole reason this exists as a curator method rather than a second writer:
   * a shared link arrives as a message, and a message is evidence, not an
   * observation. So the message is the *candidate* (the grouping call names a
   * subject from it) and also a **citation** of the page it produces, while the
   * page itself is written by the same loop and the same service call the
   * nightly pass uses.
   *
   * `ref` is a message id, or a URL that one user message contains — the user has
   * a link, not a row id. At most one page comes out: a model that proposes
   * several subjects from one link is guessing, and the user asked about *that*
   * message.
   *
   * Returns a skipped report instead of throwing when the layer/mode is off or the
   * message is unknown. A failed aux-LLM call throws the same way `run()` does:
   * the caller renders a sentence, and a silent no-op would look like a refusal.
   */
  async curateMessage(ref: string, options: CurateRunOptions = {}): Promise<CurateRunReport> {
    // Sharing *is* admission rule 3 — someone chose this message — so the default
    // trigger is an explicit one: `mode: off` refuses (below), `manual`/`share` and
    // `nightly` both run. The share trigger passes `share` so the log line tells an
    // automatic share from a typed `/knowledge share`; the two behave identically.
    const trigger: CurateTrigger = options.trigger ?? 'manual';
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
      this.logger.debug({ trigger, skip }, 'knowledge share curate skipped');
      return report;
    }

    const callLLM = this.resolveCaller() as AuxCaller;
    const message = this.findUserMessage(ref.trim());
    if (!message) {
      report.skipped = 'message_not_found';
      this.logger.debug({ ref }, 'knowledge share curate: no such message');
      return report;
    }

    report.since = message.createdAt;
    report.candidates = 1;
    if (options.signal?.aborted) {
      report.aborted = true;
      return report;
    }

    const groups = parseGroupingResponse(
      await callLLM({
        systemPrompt: GROUPING_SYSTEM_PROMPT,
        userPrompt: `${MESSAGE_GROUPING_PREFIX}\n${formatMemoryLines([message])}`,
        temperature: 0.1,
        maxTokens: 800,
        logger: this.logger,
      }),
      new Set([message.id]),
    );
    report.groups = groups.length;
    const group = groups[0];
    if (!group) {
      report.skipped = 'no_groups';
      this.logger.debug(
        { messageId: message.id },
        'knowledge share curate: the message names no subject',
      );
      return report;
    }

    return this.writeGroups([group], trigger, callLLM, report, {
      signal: options.signal,
      scope: options.scope,
      extraSources: [
        {
          kind: 'message',
          id: message.id,
          content: message.content,
          scope: null,
          confidence: null,
          conversationKey: null,
        },
      ],
    });
  }

  /**
   * The user message a share reference names, or `null`.
   *
   * Id first; a URL falls back to the newest user message whose content contains
   * it. That fallback is a `LIKE` scan, which is acceptable only because this is a
   * user-triggered command on a bounded table (`messages`, never the turn path) and
   * it stops at the first row.
   */
  private findUserMessage(ref: string): { id: string; content: string; createdAt: number } | null {
    if (!ref) return null;
    const byId = this.db
      .prepare("SELECT id, content, created_at FROM messages WHERE id = ? AND role = 'user'")
      .get(ref) as { id: string; content: string; created_at: unknown } | undefined;
    const row =
      byId ??
      (/^https?:\/\//i.test(ref)
        ? (this.db
            .prepare(
              `SELECT id, content, created_at FROM messages
                WHERE role = 'user' AND content LIKE ? ESCAPE '\\'
                ORDER BY CAST(created_at AS INTEGER) DESC LIMIT 1`,
            )
            .get(`%${escapeLike(ref)}%`) as
            { id: string; content: string; created_at: unknown } | undefined)
        : undefined);
    if (!row) return null;
    return { id: row.id, content: row.content, createdAt: parseEpochMs(row.created_at) };
  }

  /**
   * Write the groups one at a time, then log and — when every group failed and
   * nothing was written — surface the last failure.
   *
   * Shared by both entry points: one loop, one cap, one abort point, one log line,
   * so the nightly pass and a shared message cannot drift apart in how many pages
   * they write or what they report.
   */
  private async writeGroups(
    groups: readonly CurateGroup[],
    trigger: CurateTrigger,
    callLLM: AuxCaller,
    report: CurateRunReport,
    options: {
      signal?: AbortSignal;
      extraSources?: readonly CurateSource[];
      scope?: string;
    } = {},
  ): Promise<CurateRunReport> {
    const extraSources = options.extraSources ?? [];
    let lastError: unknown = null;
    for (const group of groups) {
      // Abort is honoured only here: a page write is atomic inside the service,
      // so there is no safe point to stop between "half a page" and "no page".
      if (options.signal?.aborted) {
        report.aborted = true;
        break;
      }
      if (report.created + report.updated >= this.config.maxPagesPerRun) break;

      const error = await this.curateGroup(
        group,
        trigger,
        callLLM,
        report,
        extraSources,
        options.scope,
      );
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
  private resolveCaller(): AuxCaller | null {
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
   * like a single mention forever. It also means the share flow inherits whatever
   * the memory layer already knows about the subject the message names.
   */
  private gatherSources(subject: string, groupIds: readonly string[]): CurateSource[] {
    const kinds = [...CANDIDATE_KINDS];
    const placeholders = kinds.map(() => '?').join(',');
    const idPlaceholders = groupIds.map(() => '?').join(',');
    const idClause = groupIds.length > 0 ? ` OR id IN (${idPlaceholders})` : '';
    const rows = this.db
      .prepare(
        `SELECT id, content, scope, scope_key, confidence
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
    return rows.map((row) => ({
      kind: 'memory',
      id: row.id,
      content: row.content,
      scope: row.scope,
      confidence: row.confidence,
      // `scope_key` is the session key the writer stamped (both `writeSummary()`
      // and `writePreference()` pass it), so it names the conversation that
      // attested the subject — see `countIndependentSources()`.
      conversationKey: row.scope_key,
    }));
  }

  /**
   * The pages the page call may cite: active targets only, newest first, bounded.
   *
   * Without this list the model cannot know a slug, so a `[[wikilink]]` never
   * reaches a body — and the parse in `KnowledgeRepository.writeLinks()` then has
   * nothing to store, which leaves `knowledge_links` empty even though the
   * mechanism works. It is a prompt input, not a write rule: the repository still
   * re-parses the body and resolves every target at write time, so a link this
   * list did not offer is stored as a dangling target rather than refused.
   *
   * The page being written is excluded (a page linking itself is prose, not a
   * relation) and rows whose `page_type` is outside the closed set are dropped: an
   * untyped `[[slug]]` is the only way to address them, and the body would then
   * depend on the slug being unique across types. `updated_at` is INTEGER epoch-ms
   * in `knowledge_pages` (migration v14), not the TEXT digit string of the legacy
   * tables, so this orders numerically without `parseEpochMs`.
   */
  private existingPageHints(
    page: { pageType: PageType; slug: string },
    scope?: string,
  ): ExistingPageHint[] {
    // Same read rule as everywhere else (own scope plus `global`): a page this
    // conversation cannot read is not a target it may address, and offering one
    // would put another chat's slug into this page's body as a dangling link.
    const filter = scope === undefined ? null : scopeSql('scope', scope);
    const scopeClause = filter ? ` AND ${filter.sql}` : '';
    const rows = this.db
      .prepare(
        `SELECT page_type, slug, title FROM knowledge_pages
          WHERE status = 'active' AND NOT (page_type = ? AND slug = ?)${scopeClause}
          ORDER BY updated_at DESC, id ASC
          LIMIT ?`,
      )
      .all(page.pageType, page.slug, ...(filter?.params ?? []), MAX_EXISTING_PAGE_HINTS) as Array<{
      page_type: string;
      slug: string;
      title: string;
    }>;
    return rows.flatMap((row) =>
      isPageType(row.page_type)
        ? [{ pageType: row.page_type, slug: row.slug, title: row.title }]
        : [],
    );
  }

  /**
   * Curate one group. Returns the error that made the group fail, or `null`.
   *
   * `extraSources` are the citations the group brought with it that are not
   * memories — on the share flow, the shared message itself. They count towards
   * admission, feed the page call and land in `knowledge_sources` like any other
   * citation, so a page from a shared link is traceable back to the message.
   *
   * `scope` is the conversation the page belongs to; `undefined` is `global`
   * (the nightly phase). It is passed to the lookup before the write as well as
   * to the write itself, so the two cannot disagree about which page this run is
   * updating.
   */
  private async curateGroup(
    group: CurateGroup,
    trigger: CurateTrigger,
    callLLM: AuxCaller,
    report: CurateRunReport,
    extraSources: readonly CurateSource[] = [],
    scope?: string,
  ): Promise<unknown> {
    const subject = group.subject.trim();
    // A subject that slugifies to nothing cannot identify a page; treat it as
    // unnamed so rule 1 answers for it (the service would refuse it too).
    const slug = slugifySegment(subject);
    const sources = mergeSources(extraSources, this.gatherSources(subject, group.memoryIds));
    // Admission counts conversations, not rows (see `countIndependentSources`),
    // and the collapse is logged so a refusal is readable: "1 source" out of four
    // candidate rows is a dedupe, not a thin corpus.
    const independentSources = countIndependentSources(sources);
    if (independentSources !== sources.length) {
      this.logger.debug(
        { subject, candidates: sources.length, sources: independentSources },
        'knowledge curate: candidate sources collapsed to one per conversation',
      );
    }

    const rejection = evaluateAdmission(
      {
        subject: slug ? subject : '',
        sourceCount: independentSources,
        explicitRequest: isExplicitRequest(trigger),
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
    // Derived from the memory scopes only — a shared message has no scope, and
    // letting it vote would let the share flow file `topic/x` beside the
    // `project/x` the nightly pass already wrote for the same subject.
    const scopes = sources.flatMap((source) => (source.scope === null ? [] : [source.scope]));
    const pageType: PageType =
      scopes.length > 0 && scopes.every((scope) => scope === 'project') ? 'project' : 'topic';

    let raw: string;
    try {
      raw = await callLLM({
        systemPrompt: PAGE_SYSTEM_PROMPT,
        userPrompt: `SUBJECT: ${subject}\n\nMEMORIES:\n${formatMemoryLines(sources)}\n\nEXISTING PAGES:\n${formatPageHints(this.existingPageHints({ pageType, slug }, scope))}`,
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
      kind: source.kind,
      id: source.id,
    }));
    // A message citation has no confidence, so the page's confidence is the floor
    // of what its *memories* claim; with no memory source at all it stays unset
    // rather than inheriting an invented number.
    const confidences = sources.flatMap((source) =>
      source.confidence === null ? [] : [source.confidence],
    );
    const confidence = confidences.length
      ? Math.round(Math.min(...confidences) * 100) / 100
      : undefined;
    const writeOptions: KnowledgeWriteOptions = {
      actor: 'system',
      enforceAdmission: true,
      // The user asked for this page (an explicit trigger, see
      // `isExplicitRequest`) — admission rule 3, stated to the service so it does
      // not have to infer it from the actor and then contradict the pre-flight
      // check above.
      explicitRequest: isExplicitRequest(trigger),
      // `undefined` is `global` (the nightly phase); the service normalises it.
      scope,
    };

    let result: KnowledgeWriteResult;
    try {
      // Addressed, not merely visible: a page of the same subject in *this*
      // conversation is what a re-run updates, and another chat's page is not
      // reachable from here.
      const existing = this.deps.knowledgeService.get({ slug, pageType }, { scope });
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
    // A dangling target is allowed (the repository already wrote the `link` log
    // row) but never silent: curated bodies now link routinely, so a target that
    // resolved to nothing is the signal that the existing-pages list was stale.
    if (result.danglingLinks.length > 0) {
      this.logger.debug(
        { subject, slug, dangling: result.danglingLinks },
        'knowledge curate: page links to targets that do not exist',
      );
    }
    return null;
  }

  private countRejection(report: CurateRunReport, reason: string): void {
    report.rejected[reason] = (report.rejected[reason] ?? 0) + 1;
  }
}
