/**
 * Deterministic entity normalization for knowledge pages (`knowledge:merge`).
 *
 * Two pages of the same `page_type` that name the same thing are a real defect:
 * search returns both, per-turn injection picks one arbitrarily, and a
 * `[[wikilink]]` resolves to whichever row the resolver happens to hit. Curation
 * cannot prevent it — a model that titles a page `Power Query` today and
 * `power-query` tomorrow asks for a second slug, and `slugify` cannot see that
 * the two are one identity. So the duplicates are found after the fact, by
 * string evidence only:
 *
 *   - `normalized_name` — the same name once case, whitespace and punctuation
 *     are removed (`Power Query`, `power  query`, `power_query` are all
 *     `powerquery`). Titles and slugs are both names; a slug matches a title
 *     this way, which is what catches `power-query` vs `Power Query`.
 *   - `alias_collision` — one page lists the other's name as an alias. An alias
 *     is an explicit claim of identity, so this is the strongest evidence.
 *   - `edit_distance` — one insertion/deletion/substitution apart, latin names
 *     of length >= 4 only (`Postgres` / `Postgress`). Word-length CJK has no
 *     useful edit distance: 知识图谱 and 知识库 are one edit apart and unrelated.
 *
 * ## Scope
 *
 * A page belongs to a conversation (`scope.ts`, migration-v22), and the same
 * title in two chats is the same subject discussed in two places — legitimate,
 * not a duplicate. A candidate pair therefore has to share its `scope` as well
 * as its `page_type`; grouping ignores every page from another scope entirely,
 * so a curation in chat B can never be folded into chat A's page on the same
 * subject. Global pages still merge with global pages: that is the console's one
 * namespace, and the one place where "we wrote this twice" is unambiguous.
 * Scope comes from the row and is compared as a string, which keeps the scan
 * reproducible and needs nothing from the model.
 *
 * **No model call.** A merge is destructive in a way a proposal is not, so the
 * decision that two names are one thing must be reproducible from the data —
 * the same database produces the same candidates in the same order, every run.
 * Similarity by embedding would need a page-vector table that does not exist
 * (`vec_knowledge_embeddings`; plan §6 K4 warning), so the first version is
 * string-only on purpose.
 *
 * ## What a merge keeps and what it moves
 *
 * The survivor is chosen by data, not by name length: more citations wins (it is
 * the page other pages already rely on), then older `created_at`, then `id`.
 * Applying a merge:
 *
 *   - the loser's `knowledge_sources` move to the survivor (a citation is
 *     evidence *for* a page, and the page it was evidence for just became the
 *     survivor),
 *   - `knowledge_links` pointing *at* the loser are repointed at the survivor —
 *     they are relations to the thing, and the thing is now the survivor; a
 *     link that would duplicate an existing one is dropped, not doubled,
 *   - the loser's outgoing links are left alone: they describe the loser's body,
 *     which is not merged,
 *   - the survivor absorbs the loser's names (`title`, `slug`, `aliases`) so the
 *     next search for the old name finds the survivor,
 *   - the loser is **archived, never deleted**. Every reader filters
 *     `status = 'active'`, so archiving removes it from search, injection and
 *     wikilink resolution, while the row survives as the audit trail its log
 *     entry refers to. Deleting it would cascade-delete its citations and
 *     orphan any `[[wikilink]]` in another page's body.
 *
 * Bodies are **not** concatenated. Merging two markdown bodies deterministically
 * means either dropping one (lossy) or appending one under a heading (rewrites a
 * body a human may have edited, and silently doubles its length). Neither is a
 * decision a maintenance pass may take, so the loser's body stays where it is —
 * archived, still readable through the WebUI, recorded in the log payload.
 *
 * ## The graph half
 *
 * `entities` / `entity_aliases` / `entity_edges` are keyed by *canonical name*,
 * not by page id (there is no page column, and no producer writes entities from
 * pages yet — `graph-sync` derives them from `memory_links`). So the graph is
 * repointed by name: every entity naming the loser is folded into the survivor's
 * entity of the **same `entity_type`** (never across types — that is the same
 * rule `upsertEntity` applies to aliases, and it is what keeps a person called
 * `Apple` out of the company), `memory_links` text is rewritten to the
 * survivor's title so the next projection does not resurrect the loser, and the
 * emptied loser entity row is deleted. If anything still references that row
 * after the repointing, it is kept and reported rather than deleted. An entity
 * that already *is* the survivor is classified first and never folded — the two
 * pages share a name, so most of the loser's spellings normalize onto the
 * survivor's entity too, and folding it would delete the row it was folded into.
 *
 * Bounded: candidate detection reads identity columns only (never bodies) and
 * compares edit distances inside length buckets; every name lookup is an `IN`
 * list of concrete spellings, so no pass scans a whole table; one merge runs in
 * one transaction (the phone shares one write lock with IM replies, plan §9.4).
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { hasTable, pickColumn, tableColumns } from '../../graph-export/sqlite-schema.js';
import { canonicalizeEntityName } from '../repositories/entity-repository.js';
import { normalizeScope } from './scope.js';
import { slugify } from './slug.js';
import type { PageType } from './types.js';
import { relationForPageType } from './types.js';

/** How a candidate pair was found. Strength is ranked by {@link EVIDENCE_STRENGTH}, not by this order. */
export const MERGE_EVIDENCE_KINDS = [
  'alias_collision',
  'normalized_name',
  'edit_distance',
] as const;

export type MergeEvidenceKind = (typeof MERGE_EVIDENCE_KINDS)[number];

/** Evidence that two pages are one identity. */
export interface MergeEvidence {
  kind: MergeEvidenceKind;
  /** Human-readable, deterministic: names as stored plus the key they share. */
  detail: string;
}

/** The identity columns of a page — what a merge needs, never the body. */
export interface MergePageIdentity {
  id: string;
  pageType: PageType;
  /** The conversation the page belongs to (`scope.ts`), normalised; `global` for the console's pages. */
  scope: string;
  slug: string;
  title: string;
  aliases: string[];
  createdAt: number | null;
  /** Rows in `knowledge_sources`: the survivor rule's primary criterion. */
  sourceCount: number;
}

/** One proposed merge: `loser` is archived into `survivor`. */
export interface MergeCandidate {
  pageType: PageType;
  /** Shared by both pages: a pair is only proposed inside one scope. */
  scope: string;
  survivor: MergePageIdentity;
  loser: MergePageIdentity;
  evidence: MergeEvidence[];
}

export interface MergePlanOptions {
  /** Proposals kept. Default 50; the omitted ones are reported, not dropped silently. */
  limit?: number;
  /** Restrict to these page types (default: every type). */
  pageTypes?: readonly PageType[];
}

export interface MergePlan {
  candidates: MergeCandidate[];
  /** Pairs found before `limit` truncated the list. */
  pairCount: number;
  /** Pairs dropped because one of their pages was claimed by a stronger pair. */
  claimedPairs: number;
  /** Operator-facing facts about the scan (a truncated edit-distance bucket, a malformed column). */
  notes: string[];
}

/** What one applied merge touched. Every count is what the database reported. */
export interface MergeRepointed {
  sources: number;
  /** Incoming links repointed at the survivor. */
  incomingLinks: number;
  /** Incoming links dropped because the page already linked the survivor. */
  collapsedLinks: number;
  /** Pages whose body still says `[[<loser slug>]]` and now needs a manual rewrite. */
  bodiesNeedingRewrite: string[];
  aliasesAdded: string[];
  memoryLinks: number;
  entityAliases: number;
  entityEdges: number;
  entityLosersDeleted: string[];
  /** Loser entities kept because something still referenced them. */
  entityLosersKept: string[];
}

export type MergeOutcome =
  | {
      status: 'merged';
      survivorId: string;
      loserId: string;
      repointed: MergeRepointed;
      logId: string;
    }
  | { status: 'skipped'; loserId: string; reason: string };

const DEFAULT_LIMIT = 50;

/**
 * A length bucket larger than this skips the edit-distance lane and says so.
 * Nothing is hidden: the note names the bucket, and `normalized_name` /
 * `alias_collision` still run over every name.
 */
const MAX_EDIT_DISTANCE_BUCKET = 500;

/** Latin names shorter than this are too short for one edit to mean anything. */
const MIN_EDIT_DISTANCE_LENGTH = 4;

const LATIN_NAME_RE = /^[a-z0-9]+$/;

const EVIDENCE_STRENGTH: Record<MergeEvidenceKind, number> = {
  normalized_name: 3,
  alias_collision: 2,
  edit_distance: 1,
};

/**
 * The identity key two names are compared by: NFKC (a Chinese IME emits
 * full-width `ＰＱ`), case-folded, and stripped of everything that is not a
 * letter or a digit. `Power Query`, `power-query`, `power_query` and
 * `ＰＯＷＥＲ　ＱＵＥＲＹ` all become `powerquery`; `知识图谱` keeps its Han
 * characters (no case, nothing to strip).
 *
 * Deliberately not `canonicalizeEntityName`: that one preserves punctuation
 * because it is a *storage* key (`UNIQUE(canonical_name, entity_type)`), and
 * widening it would merge distinct rows in the graph. This one is a comparison
 * key only and never leaves this module.
 */
export function normalizeMergeName(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * True when `a` and `b` differ by exactly one insertion, deletion or
 * substitution. Equal strings are not "one apart" — they are the same name, and
 * that case is the `normalized_name` lane's.
 */
export function isSingleEditApart(a: string, b: string): boolean {
  if (a === b) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (longer.length - shorter.length > 1) return false;

  let index = 0;
  while (index < shorter.length && shorter[index] === longer[index]) index += 1;

  if (shorter.length === longer.length) {
    // One substitution: everything after the first mismatch must still line up.
    return shorter.slice(index + 1) === longer.slice(index + 1);
  }
  // One insertion: the shorter string is the longer one with `index` removed.
  return shorter.slice(index) === longer.slice(index + 1);
}

/** `knowledge_pages.aliases` is JSON array text or NULL; anything else is corruption. */
function parseAliases(value: unknown, pageId: string, notes: string[]): string[] {
  if (value === null || value === undefined) return [];
  const text = String(value).trim();
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  } catch {
    notes.push(`knowledge_pages.aliases of page ${pageId} is not a JSON array — treated as empty`);
    return [];
  }
}

/** Active page identities, one grouped count query per companion table. */
function readPageIdentities(
  db: Database.Database,
  options: MergePlanOptions,
  notes: string[],
): MergePageIdentity[] {
  // A database whose v22 migration has not run yet has no `scope` column. Its
  // pages are all global by definition (that was the whole table), so the read
  // stays correct instead of throwing on a hand-restored or older file.
  const scopeColumn = pickColumn(tableColumns(db, 'knowledge_pages'), ['scope']);
  const params: unknown[] = [];
  let sql =
    'SELECT id, page_type, slug, title, aliases, created_at' +
    (scopeColumn ? `, "${scopeColumn}"` : '') +
    " FROM knowledge_pages WHERE status = 'active'";
  const types = options.pageTypes?.filter((type) => type.length > 0) ?? [];
  if (types.length > 0) {
    sql += ` AND page_type IN (${types.map(() => '?').join(', ')})`;
    params.push(...types);
  }
  // Ordered by the identity key so bucketing and the final proposal order never
  // depend on insertion order.
  sql += ' ORDER BY page_type, created_at, slug, id';

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  const sourceCounts = new Map<string, number>();
  if (hasTable(db, 'knowledge_sources')) {
    const counts = db
      .prepare('SELECT page_id, COUNT(*) AS cnt FROM knowledge_sources GROUP BY page_id')
      .all() as Array<{ page_id: string; cnt: number }>;
    for (const row of counts) sourceCounts.set(row.page_id, row.cnt);
  }

  return rows.map((row) => {
    const id = String(row.id);
    return {
      id,
      pageType: String(row.page_type) as PageType,
      scope: normalizeScope(scopeColumn ? row[scopeColumn] : undefined),
      slug: String(row.slug),
      title: String(row.title),
      aliases: parseAliases(row.aliases, id, notes),
      createdAt: typeof row.created_at === 'number' ? row.created_at : null,
      sourceCount: sourceCounts.get(id) ?? 0,
    };
  });
}

/** One name of one page: `title`, `slug` or an alias. */
interface PageName {
  page: MergePageIdentity;
  where: 'title' | 'slug' | 'alias';
  raw: string;
  key: string;
}

function namesOf(page: MergePageIdentity): PageName[] {
  const names: PageName[] = [];
  const push = (where: PageName['where'], raw: string): void => {
    const key = normalizeMergeName(raw);
    if (!key) return;
    names.push({ page, where, raw, key });
  };
  push('title', page.title);
  push('slug', page.slug);
  for (const alias of page.aliases) push('alias', alias);
  return names;
}

/** `a|b` with the smaller id first, so one pair has one map key. */
function pairKey(a: string, b: string): string {
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

interface PairAccumulator {
  survivors: Map<string, MergeEvidence[]>;
  pages: Map<string, MergePageIdentity>;
}

function addEvidence(
  accumulator: PairAccumulator,
  a: MergePageIdentity,
  b: MergePageIdentity,
  evidence: MergeEvidence,
): void {
  if (a.id === b.id) return;
  const key = pairKey(a.id, b.id);
  accumulator.pages.set(a.id, a);
  accumulator.pages.set(b.id, b);
  const existing = accumulator.survivors.get(key) ?? [];
  // The same pair can be found by several names (`PQ` alias collides *and* the
  // titles are one edit apart); each distinct reason is worth showing, but the
  // same reason twice is not. Two pages that share a title and a slug produce
  // four `normalized_name` hits for one underlying fact, and the first one found
  // is the representative — the loops below are ordered by page, then by
  // `title`/`slug`/alias, so "first" is reproducible.
  if (existing.some((entry) => entry.kind === evidence.kind)) {
    return;
  }
  existing.push(evidence);
  accumulator.survivors.set(key, existing);
}

/**
 * Candidate pairs among `pages`, never across `page_type` or `scope`.
 *
 * `page_type`: a `project` page and a `topic` page may carry the same name and
 * still be two different resources (`Power Query` the project vs the tool), and
 * folding them would lose one page_type outright — there is no survivor that is
 * both.
 *
 * `scope`: the same title in two chats is one subject discussed in two places.
 * Pairing across scopes would archive one conversation's page into another's, so
 * the grouping happens here, before any name is compared — a post-hoc filter
 * would already have ranked and claimed pages in the wrong namespace.
 */
function findPairs(pages: MergePageIdentity[], notes: string[]): PairAccumulator {
  const accumulator: PairAccumulator = { survivors: new Map(), pages: new Map() };
  const groups = new Map<
    string,
    { pageType: PageType; scope: string; pages: MergePageIdentity[] }
  >();
  for (const page of pages) {
    const key = `${page.pageType}|${page.scope}`;
    const group = groups.get(key) ?? { pageType: page.pageType, scope: page.scope, pages: [] };
    group.pages.push(page);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.pages.length < 2) continue;
    collectPairs(group.pages, accumulator, notes, group.pageType, group.scope);
  }
  return accumulator;
}

/**
 * Two lanes over one page type: a hash map over normalized names (linear), and
 * edit distance inside length buckets (one edit changes a length by at most one,
 * so a name can only pair with its own bucket and the next one). Both are
 * string-only and order-independent.
 */
function collectPairs(
  pages: MergePageIdentity[],
  accumulator: PairAccumulator,
  notes: string[],
  pageType: PageType,
  scope: string,
): void {
  // Lane 1: identical normalized name, from any name column.
  const byKey = new Map<string, PageName[]>();
  for (const page of pages) {
    for (const name of namesOf(page)) {
      const list = byKey.get(name.key) ?? [];
      list.push(name);
      byKey.set(name.key, list);
    }
  }
  for (const [key, names] of byKey) {
    if (names.length < 2) continue;
    for (let first = 0; first < names.length; first += 1) {
      for (let second = first + 1; second < names.length; second += 1) {
        const left = names[first];
        const right = names[second];
        if (left.page.id === right.page.id) continue;
        const usesAlias = left.where === 'alias' || right.where === 'alias';
        addEvidence(accumulator, left.page, right.page, {
          kind: usesAlias ? 'alias_collision' : 'normalized_name',
          detail:
            `${left.where} "${left.raw}" and ${right.where} "${right.raw}" ` +
            `both normalize to "${key}"`,
        });
      }
    }
  }

  // Lane 2: edit distance 1 among latin names of a usable length. One edit
  // changes a length by at most one, so a name only pairs with its own bucket
  // (substitution) or the next one (insertion).
  const editNames = new Map<number, PageName[]>();
  for (const page of pages) {
    for (const name of namesOf(page)) {
      if (name.key.length < MIN_EDIT_DISTANCE_LENGTH) continue;
      if (!LATIN_NAME_RE.test(name.key)) continue;
      const bucket = editNames.get(name.key.length) ?? [];
      bucket.push(name);
      editNames.set(name.key.length, bucket);
    }
  }
  const compareEditNames = (left: PageName, right: PageName): void => {
    if (left.page.id === right.page.id) return;
    if (!isSingleEditApart(left.key, right.key)) return;
    addEvidence(accumulator, left.page, right.page, {
      kind: 'edit_distance',
      detail:
        `${left.where} "${left.raw}" and ${right.where} "${right.raw}" ` +
        'differ by one character',
    });
  };
  for (const [length, bucket] of [...editNames].sort((a, b) => a[0] - b[0])) {
    if (bucket.length > MAX_EDIT_DISTANCE_BUCKET) {
      notes.push(
        `edit-distance lane skipped for ${pageType} names in scope ${scope}, ` +
          `${length} characters: ` +
          `${bucket.length} candidates (limit ${MAX_EDIT_DISTANCE_BUCKET}) — ` +
          'the exact-name lanes still covered them',
      );
      continue;
    }
    for (let first = 0; first < bucket.length; first += 1) {
      for (let second = first + 1; second < bucket.length; second += 1) {
        compareEditNames(bucket[first], bucket[second]);
      }
      const longer = editNames.get(length + 1);
      if (!longer || longer.length > MAX_EDIT_DISTANCE_BUCKET) continue;
      for (const right of longer) compareEditNames(bucket[first], right);
    }
  }
}

/**
 * Survivor rule, in order: more citations (other pages already rely on it),
 * older page (the original), smaller id. Every input is a stored column, so the
 * choice is reproducible.
 */
function chooseSurvivor(
  a: MergePageIdentity,
  b: MergePageIdentity,
): [MergePageIdentity, MergePageIdentity] {
  if (a.sourceCount !== b.sourceCount) {
    return a.sourceCount > b.sourceCount ? [a, b] : [b, a];
  }
  const aCreated = a.createdAt ?? Number.MAX_SAFE_INTEGER;
  const bCreated = b.createdAt ?? Number.MAX_SAFE_INTEGER;
  if (aCreated !== bCreated) return aCreated < bCreated ? [a, b] : [b, a];
  return a.id <= b.id ? [a, b] : [b, a];
}

function bestStrength(evidence: MergeEvidence[]): number {
  return evidence.reduce((best, entry) => Math.max(best, EVIDENCE_STRENGTH[entry.kind]), 0);
}

/**
 * Find proposals. Each page appears in at most one proposal: pairs are ranked by
 * evidence strength and then greedily claimed, because merging a page into two
 * survivors in one run is impossible (the first merge archives it) and a
 * proposal list where the same page appears twice would look like two defects.
 */
export function findMergeCandidates(
  db: Database.Database,
  options: MergePlanOptions = {},
): MergePlan {
  const notes: string[] = [];
  if (!hasTable(db, 'knowledge_pages')) {
    return {
      candidates: [],
      pairCount: 0,
      claimedPairs: 0,
      notes: ['knowledge_pages not present — start the agent once so the v14 migration runs'],
    };
  }

  const pages = readPageIdentities(db, options, notes);
  const byId = new Map(pages.map((page) => [page.id, page]));
  const accumulator = findPairs(pages, notes);

  const usable: Array<{
    first: MergePageIdentity;
    second: MergePageIdentity;
    evidence: MergeEvidence[];
  }> = [];
  for (const [key, evidence] of accumulator.survivors) {
    const [firstId, secondId] = key.split('|');
    const first = byId.get(firstId);
    const second = byId.get(secondId);
    if (first && second) usable.push({ first, second, evidence });
  }

  // Strongest evidence first, then a stable tiebreak on names and ids so the
  // same database always produces the same proposal order.
  usable.sort((left, right) => {
    const strength = bestStrength(right.evidence) - bestStrength(left.evidence);
    if (strength !== 0) return strength;
    const leftKey = `${left.first.pageType}|${left.first.slug}|${left.second.slug}`;
    const rightKey = `${right.first.pageType}|${right.first.slug}|${right.second.slug}`;
    if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
    const leftIds = `${left.first.id}|${left.second.id}`;
    const rightIds = `${right.first.id}|${right.second.id}`;
    return leftIds < rightIds ? -1 : 1;
  });

  const claimed = new Set<string>();
  const candidates: MergeCandidate[] = [];
  let claimedPairs = 0;
  for (const pair of usable) {
    const { first, second } = pair;
    if (claimed.has(first.id) || claimed.has(second.id)) {
      claimedPairs += 1;
      continue;
    }
    claimed.add(first.id);
    claimed.add(second.id);
    const [survivor, loser] = chooseSurvivor(first, second);
    candidates.push({
      pageType: survivor.pageType,
      scope: survivor.scope,
      survivor,
      loser,
      evidence: pair.evidence,
    });
  }

  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT));
  return {
    candidates: candidates.slice(0, limit),
    pairCount: candidates.length,
    claimedPairs,
    notes,
  };
}

/** Concrete spellings a name may be stored as, for a bounded SQL `IN` list. */
function spellingVariants(names: readonly string[]): string[] {
  const variants = new Set<string>();
  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    variants.add(trimmed);
    const collapsed = trimmed.replace(/\s+/g, ' ').toLowerCase();
    variants.add(collapsed);
    variants.add(trimmed.replace(/\s+/g, ' '));
    const stripped = collapsed.replace(/[^\p{L}\p{N}]+/gu, '');
    if (stripped) variants.add(stripped);
    const slugged = slugify(collapsed);
    if (slugged) variants.add(slugged);
    if (collapsed.includes('-')) variants.add(collapsed.replace(/-/g, ' '));
    if (collapsed.includes(' ')) variants.add(collapsed.replace(/ /g, '-'));
  }
  // A bound, not a guess: 999 is SQLite's historical host-parameter limit and a
  // page with more than ~140 names would need reviewing by hand anyway.
  return [...variants].sort().slice(0, 140);
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

interface GraphRepointResult {
  entityAliases: number;
  entityEdges: number;
  entityLosersDeleted: string[];
  entityLosersKept: string[];
  memoryLinks: number;
}

/**
 * True when nothing about `entityId` survives: no alias row and no edge end.
 *
 * Exported because it is the guard that decides whether the loser's entity row
 * may be deleted, and that decision is what the "never delete blindly" rule is
 * about — a test can assert it directly instead of through a contrived merge.
 */
export function canDeleteEntity(db: Database.Database, entityId: string): boolean {
  const aliases = db
    .prepare('SELECT COUNT(*) AS cnt FROM entity_aliases WHERE entity_id = ?')
    .get(entityId) as { cnt: number };
  const edges = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM entity_edges
       WHERE source_entity_id = ? OR target_entity_id = ?`,
    )
    .get(entityId, entityId) as { cnt: number };
  return aliases.cnt === 0 && edges.cnt === 0;
}

/**
 * Fold every entity naming the loser into the survivor's entity of the same
 * `entity_type`, then rewrite `memory_links` text to the survivor's title.
 *
 * Matching is by name because that is the only thing the graph and a page share
 * (no page column exists on `entities`). The lookup is a bounded `IN` list of
 * concrete spellings covering both pages, and the result is split into
 * "survivor's entity" and "loser's entity" by the same normalizer the candidate
 * scan used, so an unrelated entity is never touched.
 */
function repointGraph(
  db: Database.Database,
  input: {
    loser: MergePageIdentity;
    survivor: MergePageIdentity;
    now: number;
  },
): GraphRepointResult | null {
  if (!hasTable(db, 'entities') || !hasTable(db, 'entity_aliases')) return null;

  const loserNames = [input.loser.title, input.loser.slug, ...input.loser.aliases];
  const loserKeys = new Set(loserNames.map(normalizeMergeName).filter((key) => key.length > 0));
  const survivorNames = [input.survivor.title, input.survivor.slug, ...input.survivor.aliases];
  const survivorKeys = new Set(
    survivorNames.map(normalizeMergeName).filter((key) => key.length > 0),
  );
  // One coarse query for both sides: a spelling shared by the two pages is the
  // reason they are being merged, so querying the loser's spellings alone would
  // also return the survivor's own entity and fold it into itself.
  const spellings = spellingVariants([...loserNames, ...survivorNames]);
  const result: GraphRepointResult = {
    entityAliases: 0,
    entityEdges: 0,
    entityLosersDeleted: [],
    entityLosersKept: [],
    memoryLinks: 0,
  };
  if (spellings.length === 0 || loserKeys.size === 0) return result;

  const marks = placeholders(spellings.length);
  const matched = db
    .prepare(
      `SELECT DISTINCT e.id AS id, e.name AS name, e.canonical_name AS canonical_name,
              e.entity_type AS entity_type, e.created_at AS created_at
       FROM entities e
       WHERE e.canonical_name IN (${marks})
          OR e.id IN (SELECT entity_id FROM entity_aliases WHERE alias IN (${marks}))
       ORDER BY e.created_at, e.id`,
    )
    .all(...spellings, ...spellings) as Array<{
    id: string;
    name: string;
    canonical_name: string;
    entity_type: string;
    created_at: number | null;
  }>;

  // The SQL above is a coarse prefilter on stored spellings; this is the actual
  // rule, using the same normalizer the candidate scan used. A survivor-named
  // entity is classified first and never treated as a loser, however many of the
  // loser's spellings happen to normalize onto it — that is precisely the case a
  // merge exists to resolve, and folding the survivor into itself loses its row.
  const normalizesTo = (
    entity: { name: string; canonical_name: string },
    keys: Set<string>,
  ): boolean =>
    keys.has(normalizeMergeName(entity.canonical_name)) ||
    keys.has(normalizeMergeName(entity.name));

  const survivorEntities = matched.filter((entity) => normalizesTo(entity, survivorKeys));
  const survivorEntityIds = new Set(survivorEntities.map((entity) => entity.id));
  const loserEntities = matched.filter(
    (entity) => !survivorEntityIds.has(entity.id) && normalizesTo(entity, loserKeys),
  );

  /** First entity of `entityType` the survivor already owns, nearest in age first. */
  const survivorEntityOfType = (entityType: string): string | null => {
    const existing = survivorEntities.find((entity) => entity.entity_type === entityType);
    if (existing) return existing.id;
    const canonical = canonicalizeEntityName(input.survivor.title);
    if (!canonical) return null;
    const conflict = db
      .prepare('SELECT id FROM entities WHERE canonical_name = ? AND entity_type = ?')
      .get(canonical, entityType) as { id: string } | undefined;
    if (conflict?.id && !loserEntities.some((entity) => entity.id === conflict.id)) {
      return conflict.id;
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO entities (id, name, canonical_name, entity_type, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    ).run(id, input.survivor.title, canonical, entityType, input.now, input.now);
    survivorEntities.push({
      id,
      name: input.survivor.title,
      canonical_name: canonical,
      entity_type: entityType,
      created_at: input.now,
    });
    return id;
  };

  for (const loser of loserEntities) {
    // Never fold across entity types: `upsertEntity` scopes alias resolution to
    // the type for the same reason (a person `Apple` is not the company).
    const survivorEntityId = survivorEntityOfType(loser.entity_type);
    if (!survivorEntityId || survivorEntityId === loser.id) {
      result.entityLosersKept.push(loser.id);
      continue;
    }

    result.entityAliases +=
      db
        .prepare(
          `INSERT OR IGNORE INTO entity_aliases (entity_id, alias, source, created_at)
           SELECT ?, alias, source, created_at FROM entity_aliases WHERE entity_id = ?`,
        )
        .run(survivorEntityId, loser.id).changes +
      db
        .prepare(
          `INSERT OR IGNORE INTO entity_aliases (entity_id, alias, source, created_at)
           VALUES (?, ?, 'merge', ?)`,
        )
        .run(survivorEntityId, loser.canonical_name, input.now).changes;

    // The loser's aliases are gone only because they now live on the survivor;
    // the graph's own cascade would otherwise silently delete them.
    db.prepare('DELETE FROM entity_aliases WHERE entity_id = ?').run(loser.id);

    result.entityEdges +=
      db
        .prepare('UPDATE entity_edges SET source_entity_id = ? WHERE source_entity_id = ?')
        .run(survivorEntityId, loser.id).changes +
      db
        .prepare('UPDATE entity_edges SET target_entity_id = ? WHERE target_entity_id = ?')
        .run(survivorEntityId, loser.id).changes;

    if (canDeleteEntity(db, loser.id)) {
      db.prepare('DELETE FROM entities WHERE id = ?').run(loser.id);
      result.entityLosersDeleted.push(loser.id);
    } else {
      result.entityLosersKept.push(loser.id);
    }
  }

  // `memory_links` holds *names*, and `graph-sync` re-derives entities from them,
  // so rewriting the text is what keeps the loser from coming back on the next
  // projection. The SQL predicate is a coarse prefilter; the JS check below is
  // the same normalizer the candidate scan used, so nothing is rewritten that the
  // scan would not have paired.
  const memoryLinkSpellings = spellingVariants([...loserNames, ...survivorNames]);
  const memoryMarks = placeholders(memoryLinkSpellings.length);
  const linkRows = db
    .prepare(
      `SELECT id, subject_entity, target_entity FROM memory_links
       WHERE lower(trim(subject_entity)) IN (${memoryMarks})
          OR lower(trim(target_entity)) IN (${memoryMarks})`,
    )
    .all(...memoryLinkSpellings, ...memoryLinkSpellings) as Array<{
    id: string;
    subject_entity: string | null;
    target_entity: string;
  }>;

  const rewrite = db.prepare(
    'UPDATE memory_links SET subject_entity = ?, target_entity = ? WHERE id = ?',
  );
  for (const row of linkRows) {
    const subjectHit =
      row.subject_entity !== null && loserKeys.has(normalizeMergeName(row.subject_entity));
    const targetHit = loserKeys.has(normalizeMergeName(row.target_entity));
    if (!subjectHit && !targetHit) continue;
    // A row that already spells the survivor needs no write. The loser's key is
    // often the survivor's key too (that is why the pages were paired), so
    // without this guard a `Power Query` link would be "repointed" onto itself
    // and the audit log would claim a change that never happened.
    const nextSubject = subjectHit ? input.survivor.title : row.subject_entity;
    const nextTarget = targetHit ? input.survivor.title : row.target_entity;
    if (nextSubject === row.subject_entity && nextTarget === row.target_entity) continue;
    rewrite.run(nextSubject, nextTarget, row.id);
    result.memoryLinks += 1;
  }

  return result;
}

/**
 * Merged alias list: the survivor's own names, then everything the loser was
 * called.
 *
 * Deduplicated by `toLowerCase()` of the trimmed text — the exact predicate
 * `KnowledgeRepository.findByTitleOrAlias` matches an alias with (`lower(value)
 * = lower(?)`). Deduplicating by the *normalized* key instead would drop
 * `power  query` and `Power_Query` as "the same as `Power Query`", and those are
 * the literal spellings an alias exists to remember: a query with two spaces
 * does not match `Power Query` under `lower(...) = lower(...)`.
 */
function mergedAliases(survivor: MergePageIdentity, loser: MergePageIdentity): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();
  const claim = (value: string): void => {
    const key = value.trim().toLowerCase();
    if (key) seen.add(key);
  };
  claim(survivor.title);
  claim(survivor.slug);
  const push = (value: string): void => {
    const trimmed = value.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) return;
    seen.add(key);
    kept.push(trimmed);
  };
  for (const alias of survivor.aliases) push(alias);
  push(loser.title);
  for (const alias of loser.aliases) push(alias);
  push(loser.slug);
  return kept;
}

function readPageRow(db: Database.Database, id: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM knowledge_pages WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
}

/**
 * Apply one proposal. Runs inside the caller's transaction (see
 * {@link applyMergePlan}) so the survivor's aliases, the loser's archive and the
 * log row land together or not at all.
 */
function applyCandidate(
  db: Database.Database,
  candidate: MergeCandidate,
  now: number,
): MergeOutcome {
  const survivorRow = readPageRow(db, candidate.survivor.id);
  const loserRow = readPageRow(db, candidate.loser.id);
  if (!survivorRow || !loserRow) {
    return { status: 'skipped', loserId: candidate.loser.id, reason: 'page no longer exists' };
  }
  if (survivorRow.status !== 'active' || loserRow.status !== 'active') {
    // A page merged earlier in the same run has already been archived; applying
    // the second proposal would fold an archived page into another survivor.
    return {
      status: 'skipped',
      loserId: candidate.loser.id,
      reason: 'page is no longer active (merged or archived earlier)',
    };
  }

  const loserAliases = parseAliases(loserRow.aliases, candidate.loser.id, []);
  const survivorAliases = parseAliases(survivorRow.aliases, candidate.survivor.id, []);
  const survivor: MergePageIdentity = { ...candidate.survivor, aliases: survivorAliases };
  const loser: MergePageIdentity = { ...candidate.loser, aliases: loserAliases };
  const aliases = mergedAliases(survivor, loser);

  const sources = db
    .prepare(
      `INSERT OR IGNORE INTO knowledge_sources (page_id, source_kind, source_id, created_at)
       SELECT ?, source_kind, source_id, created_at FROM knowledge_sources WHERE page_id = ?`,
    )
    .run(survivor.id, loser.id).changes;
  db.prepare('DELETE FROM knowledge_sources WHERE page_id = ?').run(loser.id);

  const incoming = db
    .prepare(
      `SELECT from_page_id, label FROM knowledge_links
       WHERE to_page_id = ? AND from_page_id <> ? ORDER BY from_page_id`,
    )
    .all(loser.id, loser.id) as Array<{ from_page_id: string; label: string | null }>;
  // The predicate is derived from the target's page_type — the same invariant
  // `repository.writeLinks()` keeps. A copied row that carries NULL would sit
  // untyped until the next boot's backfill fixed it.
  const relationType = relationForPageType(candidate.pageType) ?? null;
  const insertLink = db.prepare(
    `INSERT OR IGNORE INTO knowledge_links (from_page_id, to_page_id, label, relation_type, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const deleteLink = db.prepare(
    'DELETE FROM knowledge_links WHERE from_page_id = ? AND to_page_id = ?',
  );
  let incomingLinks = 0;
  let collapsedLinks = 0;
  const bodiesNeedingRewrite = new Set<string>();
  for (const row of incoming) {
    const inserted = insertLink.run(
      row.from_page_id,
      survivor.id,
      row.label,
      relationType,
      now,
    ).changes;
    if (inserted > 0) incomingLinks += 1;
    else collapsedLinks += 1;
    deleteLink.run(row.from_page_id, loser.id);
    // The linking body still says `[[<loser slug>]]`; that text resolves to
    // nothing once the loser is archived, and rewriting another page's markdown
    // is not a maintenance pass's decision.
    bodiesNeedingRewrite.add(row.from_page_id);
  }

  db.prepare(
    `UPDATE knowledge_pages
     SET aliases = ?, version = version + 1, updated_at = ?, updated_by = 'system'
     WHERE id = ?`,
  ).run(aliases.length > 0 ? JSON.stringify(aliases) : null, now, survivor.id);

  db.prepare(
    `UPDATE knowledge_pages
     SET status = 'archived', version = version + 1, updated_at = ?, updated_by = 'system'
     WHERE id = ?`,
  ).run(now, loser.id);

  const graph = repointGraph(db, { loser, survivor, now });
  const survivorVersion = (
    db.prepare('SELECT version FROM knowledge_pages WHERE id = ?').get(survivor.id) as {
      version: number;
    }
  ).version;

  const repointed: MergeRepointed = {
    sources,
    incomingLinks,
    collapsedLinks,
    bodiesNeedingRewrite: [...bodiesNeedingRewrite].sort(),
    aliasesAdded: aliases.filter(
      (alias) => !survivorAliases.some((kept) => kept.toLowerCase() === alias.toLowerCase()),
    ),
    memoryLinks: graph?.memoryLinks ?? 0,
    entityAliases: graph?.entityAliases ?? 0,
    entityEdges: graph?.entityEdges ?? 0,
    entityLosersDeleted: graph?.entityLosersDeleted ?? [],
    entityLosersKept: graph?.entityLosersKept ?? [],
  };

  const logId = randomUUID();
  db.prepare(
    `INSERT INTO knowledge_log (id, page_id, action, actor, version, reason, created_at)
     VALUES (?, ?, 'merge', 'system', ?, ?, ?)`,
  ).run(
    logId,
    survivor.id,
    survivorVersion,
    JSON.stringify({
      merger: 'knowledge:merge',
      survivor: pageRef(survivor),
      loser: pageRef(loser),
      evidence: candidate.evidence,
      repointed,
      bodyMerged: false,
      notes:
        repointed.bodiesNeedingRewrite.length > 0
          ? ['pages linking the loser still carry its slug in their body text']
          : [],
    }),
    now,
  );

  return { status: 'merged', survivorId: survivor.id, loserId: loser.id, repointed, logId };
}

function pageRef(page: MergePageIdentity): {
  id: string;
  pageType: PageType;
  scope: string;
  slug: string;
  title: string;
} {
  return {
    id: page.id,
    pageType: page.pageType,
    scope: page.scope,
    slug: page.slug,
    title: page.title,
  };
}

/**
 * Apply a plan. One transaction per proposal — the phone shares a single write
 * lock with IM replies (`busy_timeout = 5000`), so a batch must never be one
 * long transaction (plan §9.4 item 2).
 */
export function applyMergePlan(
  db: Database.Database,
  plan: MergePlan,
  options: { now?: () => number } = {},
): MergeOutcome[] {
  const clock = options.now ?? (() => Date.now());
  const applyOne = db.transaction((candidate: MergeCandidate): MergeOutcome =>
    applyCandidate(db, candidate, clock()),
  );
  return plan.candidates.map((candidate) => applyOne(candidate));
}
