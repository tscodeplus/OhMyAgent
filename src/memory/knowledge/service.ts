/**
 * The knowledge service: everything a caller must not decide for itself.
 *
 * `KnowledgeRepository` stores pages; this layer decides *whether* to store one
 * and *what a reader is allowed to see*. Three rules from the plan live here and
 * nowhere else:
 *
 * 1. **Admission** (K2-3.2). A page has to clear two of three: a nameable
 *    subject, recurrence across ≥ `requireSources` independent sources, or an
 *    explicit request. Enforced only when `enforceAdmission` is set — that flag
 *    is what "this is a curation write" means (a user or the model writing on an
 *    explicit instruction *is* the authority the rules approximate).
 * 2. **Shadow mode.** When `shadow` is on, a curation write lands as `pending`
 *    instead of `active` and stays out of search, injection and link resolution
 *    until a human approves it.
 * 3. **Citations.** Every source must resolve to a real memory/message/session
 *    row at write time (`unknown_sources`). This is the anti-hallucination gate.
 *
 * Read-side, `status === 'active'` is the default and the only status `search`,
 * `get`, `list` and `titlesForInjection` return unless the caller names another
 * one. `listPending` is the single review-queue accessor.
 */

import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type {
  CreateKnowledgePageInput,
  KnowledgeBacklink,
  KnowledgePage,
  KnowledgePageStatus,
  KnowledgeSourceInput,
  PageType,
  UpdateKnowledgePageInput,
} from './types.js';
import { PAGE_TYPES, isPageType } from './types.js';
import type {
  KnowledgeActor,
  KnowledgeListOptions,
  KnowledgePageDetail,
  KnowledgeRuntimeConfig,
  KnowledgeSearchHit,
  KnowledgeSearchOptions,
  KnowledgeService,
  KnowledgeWriteOptions,
  KnowledgeWriteResult,
} from './service-contract.js';
import {
  KnowledgeRepository,
  type KnowledgePageRef,
  type KnowledgePageWriteResult,
} from './repository.js';
import { buildSnippet, searchKnowledgeIndex } from './indexer.js';
import { parseWikilinks } from './links.js';
import { slugify } from './slug.js';
import { normalizeScope } from './scope.js';
import { parseEpochMs } from '../../shared/timestamp.js';

/** Defaults mirror the `knowledge:` block in the plan (§9.1). */
export const DEFAULT_KNOWLEDGE_RUNTIME_CONFIG: KnowledgeRuntimeConfig = {
  enabled: true,
  requireSources: 2,
  minMemoryConfidence: 0.6,
  shadow: false,
  logRetentionDays: 90,
};

export interface KnowledgeServiceDeps {
  db: Database.Database;
  /** Subset of the `knowledge:` config block; omitted keys take the defaults. */
  config?: Partial<KnowledgeRuntimeConfig>;
  logger?: Pick<Logger, 'debug' | 'info' | 'warn'>;
}

const DEFAULT_SEARCH_LIMIT = 6;
const MAX_SEARCH_LIMIT = 20;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/** RRF smoothing for the two page lanes — the same `k` `rrf-merge.ts` defaults to. */
const RRF_K = 60;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Distinct citations: the same memory twice is one source, not two. */
function dedupeSources(sources: KnowledgeSourceInput[]): KnowledgeSourceInput[] {
  const seen = new Set<string>();
  const out: KnowledgeSourceInput[] = [];
  for (const source of sources) {
    const id = source.id?.trim();
    if (!id) continue;
    const key = `${source.kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: source.kind, id });
  }
  return out;
}

/** One lane's candidate: the page it matched and the snippet cut for it. */
interface SearchCandidate {
  page: KnowledgePage;
  snippet: string;
}

// ── admission (§6 K2-3.2) ──────────────────────────────────────────────────

/**
 * Titles that are a stance about someone, not the name of something. `用户希望…`
 * / `User prefers…` is a preference statement — it belongs in `memories`, which
 * is allowed to expire, not in a page that claims to be durable knowledge.
 */
const SUBJECTLESS_TITLE_PREFIX = /^(用户|我|我们|本人|大家|你|user|the user|i|we|they|someone)\s*/i;

/** A preference verb anywhere in the title is a strong "this has no subject" signal. */
const PREFERENCE_VERB =
  /(希望|想要|希望要|要求|喜欢|倾向于|wants?|hopes?|would like|prefers?|likes?|needs?)/i;

type AdmissionRule = 'subject' | 'recurrence' | 'requested';

type AdmissionRejectionReason = 'no_subject' | 'not_recurrent' | 'not_requested';

const ADMISSION_REJECTION_REASON: Record<AdmissionRule, AdmissionRejectionReason> = {
  subject: 'no_subject',
  recurrence: 'not_recurrent',
  requested: 'not_requested',
};

interface AdmissionCheck {
  rule: AdmissionRule;
  passed: boolean;
  detail: string;
}

/** Rule 1: the page can be named after a thing, not after a wish. */
function checkSubject(title: string): AdmissionCheck {
  const trimmed = title.trim();
  if (trimmed.length < 2) {
    return { rule: 'subject', passed: false, detail: 'title is empty or a single character' };
  }
  const stripped = trimmed.replace(SUBJECTLESS_TITLE_PREFIX, '');
  if (stripped !== trimmed) {
    return {
      rule: 'subject',
      passed: false,
      detail: `title "${trimmed}" starts with a speaker rather than a subject`,
    };
  }
  const verb = trimmed.match(PREFERENCE_VERB)?.[0];
  if (verb) {
    return {
      rule: 'subject',
      passed: false,
      detail: `title "${trimmed}" is a preference statement ("${verb}"), not a subject`,
    };
  }
  return { rule: 'subject', passed: true, detail: `title "${trimmed}" names a subject` };
}

/**
 * Evaluate the three admission rules.
 *
 * `requested` defaults to "the write is attributed to the user" — a write the
 * user made *is* the explicit request ("记下来 / 整理成文档") — because the service
 * never sees the turn's text. `KnowledgeWriteOptions.explicitRequest` is the
 * channel for a caller that knows better: the curator's `manual` trigger (the
 * user ran a command that asked for the page) says so while still attributing
 * the body to `system`.
 */
function evaluateAdmission(input: {
  title: string;
  sources: KnowledgeSourceInput[];
  requireSources: number;
  requested: boolean;
}): AdmissionCheck[] {
  return [
    checkSubject(input.title),
    {
      rule: 'recurrence',
      passed: input.sources.length >= input.requireSources,
      detail: `${input.sources.length} independent source(s), ${input.requireSources} required`,
    },
    {
      rule: 'requested',
      passed: input.requested,
      detail: input.requested ? 'explicit user request' : 'no explicit request',
    },
  ];
}

// ── service ────────────────────────────────────────────────────────────────

export function createKnowledgeService(deps: KnowledgeServiceDeps): KnowledgeService {
  const { db, logger } = deps;
  const config: KnowledgeRuntimeConfig = { ...DEFAULT_KNOWLEDGE_RUNTIME_CONFIG, ...deps.config };
  const repository = new KnowledgeRepository(db);

  // `config.enabled` is deliberately not consulted here: it gates whether the
  // tools are registered at all (layer inert), while a registered service must
  // still serve reads when curation is switched off.

  /**
   * Active pages matching `query`, best first.
   *
   * Two lanes answer "is there a page about this": BM25 over
   * `knowledge_fts_jieba` (body *and* title since migration-v20) and the name leg
   * (`findByTitleOrAlias`: title prefix, exact slug, exact alias) for what BM25
   * cannot reach — an acronym stored as an alias, or the half of a title the
   * searcher remembered.
   *
   * They are fused **by rank** (`score = Σ 1 / (rank + k)`, k = 60, the formula
   * `rrf-merge.ts` implements), never by adding their numbers: a BM25 magnitude
   * and "the name matched" are not on one scale, and adding them lets whichever
   * lane's arithmetic happens to be larger decide every query. A page both lanes
   * found collects two contributions and therefore outranks a page only one lane
   * found, which is the point — a name match plus a body match is the strongest
   * evidence there is. `laneSnippets` remembers which lane supplied the text, so
   * the snippet is cut from the body the match actually came from.
   */
  function search(rawQuery: string, options?: KnowledgeSearchOptions): KnowledgeSearchHit[] {
    const query = rawQuery.trim();
    if (!query) return [];
    const limit = clamp(options?.limit ?? DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
    const filters = {
      status: 'active' as KnowledgePageStatus,
      pageType: options?.pageType,
      tag: options?.tag,
      scope: options?.scope,
      limit,
    };

    // Name leg first: lane order is also the tie-break, and a page found only by
    // name beats a page found only by BM25 on an equal fused score.
    const nameLane: SearchCandidate[] = repository
      .findByTitleOrAlias(query, filters)
      .map((page) => ({ page, snippet: buildSnippet(page.content, query) }));

    const bodyLane: SearchCandidate[] = searchKnowledgeIndex(db, query, filters).flatMap((row) => {
      const page = repository.findById(row.pageId);
      // The SQL already filters on status; this keeps a stale index row from
      // becoming a hit if the page vanished between the two statements.
      if (!page || page.status !== 'active') return [];
      return [{ page, snippet: buildSnippet(row.contentOriginal, query) }];
    });

    const fused = new Map<string, { hit: KnowledgeSearchHit; laneIndex: number }>();
    [nameLane, bodyLane].forEach((lane, laneIndex) => {
      const seen = new Set<string>();
      lane.forEach((candidate, rank) => {
        // One page, one contribution per lane: a duplicated index row must not
        // look like a second lane agreeing.
        if (seen.has(candidate.page.id)) return;
        seen.add(candidate.page.id);

        const contribution = 1 / (rank + 1 + RRF_K);
        const existing = fused.get(candidate.page.id);
        if (existing) {
          existing.hit.score += contribution;
          return;
        }
        fused.set(candidate.page.id, {
          laneIndex,
          hit: {
            id: candidate.page.id,
            slug: candidate.page.slug,
            pageType: candidate.page.page_type,
            title: candidate.page.title,
            snippet: candidate.snippet,
            score: contribution,
            updatedAt: parseEpochMs(candidate.page.updated_at),
          },
        });
      });
    });

    return [...fused.values()]
      .sort((a, b) => b.hit.score - a.hit.score || a.laneIndex - b.laneIndex)
      .slice(0, limit)
      .map((entry) => entry.hit);
  }

  function findPage(ref: KnowledgePageRef, scope?: string): KnowledgePage | undefined {
    return 'id' in ref
      ? repository.findById(ref.id, scope)
      : repository.findBySlug(ref.slug, ref.pageType, scope);
  }

  function get(ref: KnowledgePageRef, options?: { scope?: string }): KnowledgePageDetail | null {
    const scope = options?.scope;
    const page = findPage(ref, scope);
    // Active-only: the signature has no status option, so a pending page is not
    // readable here at all. The review queue reads bodies via `listPending`.
    if (!page || page.status !== 'active') return null;

    // Resolved from the body rather than read from `knowledge_links`, because
    // only the parse knows which targets are *missing*: the link table holds the
    // relations that exist, never the citations that point nowhere.
    const links = parseWikilinks(page.content).flatMap((link) => {
      const target = link.pageType
        ? repository.findBySlug(link.slug, link.pageType, scope)
        : repository.findBySlug(link.slug, undefined, scope);
      // A page mentioning itself is prose, not a relation.
      if (target?.id === page.id) return [];
      return [
        {
          slug: link.target,
          label: link.label,
          missing: !target || target.status !== 'active',
        },
      ];
    });

    return { page, sources: repository.sourcesOf(page.id), links };
  }

  function list(options?: KnowledgeListOptions): KnowledgePage[] {
    return repository.list({
      status: options?.status ?? 'active',
      pageType: options?.pageType,
      scope: options?.scope,
      limit: clamp(options?.limit ?? DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT),
      offset: Math.max(0, Math.floor(options?.offset ?? 0)),
    });
  }

  function listPending(limit?: number): KnowledgePage[] {
    return list({ status: 'pending', limit: clamp(limit ?? 20, 1, MAX_LIST_LIMIT) });
  }

  function create(
    input: CreateKnowledgePageInput,
    options: KnowledgeWriteOptions,
  ): KnowledgeWriteResult {
    if (!isPageType(input.pageType)) {
      return { ok: false, code: 'invalid_page_type', allowed: PAGE_TYPES };
    }

    const sources = dedupeSources(input.sources ?? []);
    if (sources.length === 0) {
      // No citation at all is the same defect as a citation that does not
      // exist, and the closed rejection set has one code for it.
      return { ok: false, code: 'unknown_sources', missing: [] };
    }
    const missing = repository.missingSources(sources);
    if (missing.length > 0) return { ok: false, code: 'unknown_sources', missing };

    const slug = slugify(input.slug) || slugify(input.title);
    if (!slug) {
      return {
        ok: false,
        code: 'admission_rejected',
        reason: 'no_subject',
        detail: `no slug could be derived from "${input.slug}" or "${input.title}"`,
      };
    }

    if (options.enforceAdmission === true) {
      const checks = evaluateAdmission({
        title: input.title,
        sources,
        requireSources: Math.max(1, config.requireSources),
        requested: options.explicitRequest ?? options.actor === 'user',
      });
      const failed = checks.filter((check) => !check.passed);
      // Two of three rules must pass; `failed[0]` exists whenever we reject.
      const firstFailed = failed[0];
      if (checks.length - failed.length < 2 && firstFailed) {
        return {
          ok: false,
          code: 'admission_rejected',
          reason: ADMISSION_REJECTION_REASON[firstFailed.rule],
          detail: checks.map((check) => `${check.rule}: ${check.detail}`).join('; '),
        };
      }
    }

    // Shadow applies to curation only: `enforceAdmission` is the marker for
    // "this write came from the curator", so a model writing on an explicit
    // instruction is not silently queued for review.
    const isCuration = options.enforceAdmission === true;
    const status: KnowledgePageStatus =
      input.status ?? (config.shadow && isCuration ? 'pending' : 'active');

    const scope = normalizeScope(options.scope);
    const result = repository.insertPage(
      {
        ...input,
        slug,
        sources,
        status,
        scope,
        updatedBy: input.updatedBy ?? options.actor,
      },
      options.actor,
    );
    return toWriteResult(result);
  }

  function update(
    ref: KnowledgePageRef,
    input: UpdateKnowledgePageInput,
    options: KnowledgeWriteOptions,
  ): KnowledgeWriteResult {
    const patch = { ...input, updatedBy: input.updatedBy ?? options.actor };

    if (patch.sources !== undefined) {
      const sources = dedupeSources(patch.sources);
      if (sources.length === 0) return { ok: false, code: 'unknown_sources', missing: [] };
      const missing = repository.missingSources(sources);
      if (missing.length > 0) return { ok: false, code: 'unknown_sources', missing };
      patch.sources = sources;
    }

    return toWriteResult(
      repository.updatePage(ref, patch, options.actor, normalizeScope(options.scope)),
    );
  }

  function setStatus(id: string, status: KnowledgePageStatus, actor: KnowledgeActor): boolean {
    const changed = repository.setStatus(id, status, actor);
    if (changed) logger?.debug({ pageId: id, status, actor }, 'knowledge page status changed');
    return changed;
  }

  function titlesForInjection(
    query: string,
    max: number,
    options?: { scope?: string },
  ): Array<{ slug: string; title: string; score?: number }> {
    const limit = clamp(max, 1, 5);
    if (!query.trim()) return [];

    // The scope is handed to `search` and nothing else: the floor and the
    // normalisation below then run over the pages this caller may read, so
    // another chat's better-scoring title can neither be injected nor push a
    // visible title out of the result set. Absent, the call is exactly what it
    // was before migration-v22 (every scope, the console's view).
    const hits = search(query, options?.scope ? { limit, scope: options.scope } : { limit });
    if (hits.length === 0) return [];

    // The fused score is an RRF value: comparable inside this result set and
    // nowhere else, so relevance is reported relative to the best hit in it
    // (top = 1). The former `x / (1 + x)` BM25 curve cannot be reused here — an
    // RRF value sits near 1/61, so it would report ≈0.016 for every hit and lose
    // every cross-lane comparison against the episodic lane.
    const top = hits[0].score;
    if (top <= 0) return [];
    // Relevance floor, relative to the best hit in this set: a title that scores
    // half as well as the top one is a weak guess, and injection budget is spent
    // on every turn. Absolute thresholds are meaningless across query lengths,
    // so the comparison stays within the set (the contract's own caveat).
    const floor = top / 2;
    return hits
      .filter((hit) => hit.score >= floor)
      .slice(0, limit)
      .map((hit) => ({ slug: hit.slug, title: hit.title, score: hit.score / top }));
  }

  function linksOf(pageId: string) {
    return repository.linksOf(pageId);
  }

  /**
   * The active pages whose body cites `ref`.
   *
   * Resolved through the same active-only lookup as `get`, so a `pending` or
   * `archived` page has no backlinks to show: its body is not readable, and a
   * panel of pages pointing at it would be a second way to read it.
   */
  function backlinks(ref: KnowledgePageRef): KnowledgeBacklink[] {
    const page = findPage(ref);
    if (!page || page.status !== 'active') return [];
    return repository.linksTo(page.id);
  }

  return {
    search: (query, options) => search(query, options),
    get,
    list,
    listPending,
    create,
    update,
    setStatus,
    titlesForInjection,
    linksOf,
    backlinks,
  };
}

/** Map the repository's outcome onto the service contract. */
function toWriteResult(result: KnowledgePageWriteResult): KnowledgeWriteResult {
  if (!result.ok) return result;
  return {
    ok: true,
    id: result.page.id,
    slug: result.page.slug,
    pageType: result.page.page_type,
    version: result.page.version,
    status: result.page.status,
    created: result.created,
    danglingLinks: result.danglingLinks,
  };
}
