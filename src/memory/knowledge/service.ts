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

  function search(rawQuery: string, options?: KnowledgeSearchOptions): KnowledgeSearchHit[] {
    const query = rawQuery.trim();
    if (!query) return [];
    const limit = clamp(options?.limit ?? DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);

    const hits: KnowledgeSearchHit[] = [];
    const seen = new Set<string>();
    let bestScore = 0;

    for (const row of searchKnowledgeIndex(db, query, {
      status: 'active',
      pageType: options?.pageType,
      tag: options?.tag,
      limit,
    })) {
      const page = repository.findById(row.pageId);
      // The SQL already filters on status; this keeps a stale index row from
      // becoming a hit if the page vanished between the two statements.
      if (!page || page.status !== 'active') continue;
      if (seen.has(page.id)) continue;
      seen.add(page.id);

      const score = -row.bm25Score; // BM25 rank is negative; flip to "higher is better"
      bestScore = Math.max(bestScore, score);
      hits.push({
        id: page.id,
        slug: page.slug,
        pageType: page.page_type,
        title: page.title,
        snippet: buildSnippet(row.contentOriginal, query),
        score,
      });
    }

    // Title / alias / slug leg: the index holds bodies only, so `PQ` stored as
    // an alias of `Power Query` is invisible to BM25. These hits are ranked
    // above every BM25 hit (an exact name match beats a body match); the
    // contract only promises scores comparable within one result set.
    for (const page of repository.findByTitleOrAlias(query, {
      status: 'active',
      pageType: options?.pageType,
      tag: options?.tag,
      limit,
    })) {
      if (seen.has(page.id)) continue;
      seen.add(page.id);
      hits.push({
        id: page.id,
        slug: page.slug,
        pageType: page.page_type,
        title: page.title,
        snippet: buildSnippet(page.content, query),
        score: bestScore * 2 + 1,
      });
    }

    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  function findPage(ref: KnowledgePageRef): KnowledgePage | undefined {
    return 'id' in ref
      ? repository.findById(ref.id)
      : repository.findBySlug(ref.slug, ref.pageType);
  }

  function get(ref: KnowledgePageRef): KnowledgePageDetail | null {
    const page = findPage(ref);
    // Active-only: the signature has no status option, so a pending page is not
    // readable here at all. The review queue reads bodies via `listPending`.
    if (!page || page.status !== 'active') return null;

    // Resolved from the body rather than read from `knowledge_links`, because
    // only the parse knows which targets are *missing*: the link table holds the
    // relations that exist, never the citations that point nowhere.
    const links = parseWikilinks(page.content).flatMap((link) => {
      const target = link.pageType
        ? repository.findBySlug(link.slug, link.pageType)
        : repository.findBySlug(link.slug);
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

    const result = repository.insertPage(
      {
        ...input,
        slug,
        sources,
        status,
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

    return toWriteResult(repository.updatePage(ref, patch, options.actor));
  }

  function setStatus(id: string, status: KnowledgePageStatus, actor: KnowledgeActor): boolean {
    const changed = repository.setStatus(id, status, actor);
    if (changed) logger?.debug({ pageId: id, status, actor }, 'knowledge page status changed');
    return changed;
  }

  function titlesForInjection(
    query: string,
    max: number,
  ): Array<{ slug: string; title: string; score?: number }> {
    const limit = clamp(max, 1, 5);
    if (!query.trim()) return [];

    const hits = search(query, { limit });
    if (hits.length === 0) return [];

    // Relevance floor, relative to the best hit in this set: a title that scores
    // half as well as the top one is a weak guess, and injection budget is spent
    // on every turn. Absolute thresholds are meaningless across query lengths,
    // so the comparison stays within the set (the contract's own caveat).
    const floor = hits[0].score > 0 ? hits[0].score / 2 : 0;
    return (
      hits
        .filter((hit) => hit.score >= floor)
        .slice(0, limit)
        // `score` is reported as relevance in (0,1] — the same BM25→(0,1) curve
        // `conversation-search` uses (`x / (1 + x)`) — because the caller ranks
        // this lane against the conversation lane, and a raw −bm25 magnitude (or
        // a title hit's `bestScore * 2 + 1`) is not on that scale.
        .map((hit) => ({ slug: hit.slug, title: hit.title, score: hit.score / (1 + hit.score) }))
    );
  }

  function linksOf(pageId: string) {
    return repository.linksOf(pageId);
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
