/**
 * Related notes — the writer for `note_relations`.
 *
 * The layer was designed with this table and a reader (`relatedFor`) but no
 * producer, so the detail page's 「相关 N 条」 block could never render. This file is
 * the producer, and it stays deliberately cheap: **three local signals, no model and
 * no embeddings.**
 *
 * Why no model. At the scale this library actually has (single digits today, a few
 * hundred after a year) a model call per note buys recall nobody can verify, and a
 * wrong "these are related" costs more than a missing one — the list is read as an
 * invitation to click. The repo also just deleted a vector-backed entity graph;
 * reintroducing embeddings for seven notes would be the same trap with less data.
 *
 * The three rules, strongest first. A pair keeps **one** basis — the strongest that
 * fired — because "why is this related" must have a single answer:
 *
 *   1. `session` (0.9)  — distilled from the same conversation (`notes.session_id`).
 *      The common case, and the only one with hard evidence behind it: of the seven
 *      materials measured during the kind review, four produced two notes each.
 *   2. `title`   (0.6)  — one title's words are nearly contained in the other's.
 *      Nearly, not exactly: equal titles are the *duplicate* case, which
 *      `findByTitle()` already refuses at capture.
 *   3. `tags`    (0.4+) — shared free tags. **Free tags only, never facets** — see
 *      `tagJaccard()` — and never *filter tags*: a tag a third of the scope's live
 *      notes carry is a filter whatever its origin, so it is excluded by frequency
 *      (`FILTER_TAG_*`), not by a list someone maintains.
 *
 * Scope: a pair must sit in the **same `(scope, scope_key)`**. A relation renders the
 * other note's *title*, so a link across chats would leak it, and a read-time filter
 * cannot un-leak a title it has already shown. Same-scope only is stricter than the
 * notes read rule and needs no second implementation to stay in sync.
 *
 * Cost: one scoped candidate query per written note, at most `MAX_RELATIONS` rows per
 * note per direction after trimming. Everything runs inside the caller's transaction.
 */

import type Database from 'better-sqlite3';
import { ZH_STOP_WORDS, cutAll } from '../memory/fts-tokenizer.js';

/** Rows kept per note, in each direction. The detail page shows at most this many. */
export const MAX_RELATIONS = 5;

/**
 * Below this a pair is not worth a row.
 *
 * No rule can currently fall below it (0.9 / 0.6 / 0.4+), which is the point: the
 * floor exists so that re-tuning a weight cannot silently start storing weak edges.
 */
export const MIN_SCORE = 0.4;

/** Jaccard floor for the tag rule. One shared tag out of four is 0.25 and does not count. */
const MIN_TAG_JACCARD = 0.34;

/**
 * Frequency exclusion for the tag rule (see `tagJaccard`).
 *
 * The old `kind` column moved into tags as aspect tags (`pitfall`, `command`, …),
 * which are by nature high-frequency: in a mature library a third of the notes may
 * carry `pitfall`, and scoring over it would link every pitfall to every other —
 * the exact failure the facet exclusion exists to prevent, arriving through the
 * tags column instead of the index. The principled fix is not an origin list (that
 * would be `kind` reborn as hidden state) but behaviour: **a tag that behaves like a
 * filter is a filter.** A tag present on at least `FILTER_TAG_RATIO` of a scope's
 * live notes drops out of the *relation* scoring only — it stays a facet filter,
 * stays in the FTS index, stays counted.
 *
 * `FILTER_TAG_MIN_LIVE` keeps small scopes honest: with two notes a shared tag is
 * 50% by arithmetic, and excluding it would refuse the one relation the scope has.
 */
export const FILTER_TAG_MIN_LIVE = 3;
export const FILTER_TAG_RATIO = 1 / 3;

/** Containment floor for the title rule, over the smaller token set. */
const MIN_TITLE_CONTAINMENT = 0.8;

/** A one-word title cannot be meaningfully "contained" by anything. */
const MIN_TITLE_TOKENS = 2;

export type RelationBasis = 'session' | 'title' | 'tags';

export interface RelationRow {
  noteId: string;
  relatedId: string;
  score: number;
  basis: RelationBasis;
}

/**
 * Title tokens for the containment rule.
 *
 * Neither existing tokenizer fits: `segmentCJK()` drops Latin by design (its callers
 * want Chinese words) and a title like `Ubuntu 26.04 LTS` is almost all Latin, while
 * `tokenizeForIndex()` returns one joined string. `cutAll()` is the third entry point
 * added for this.
 *
 * Digits survive — `26.04` is a real distinction between two otherwise identical
 * Ubuntu titles — but a bare year cannot relate two notes on its own, because the
 * rule needs `MIN_TITLE_TOKENS` of them.
 */
export function titleTokens(title: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // Structural punctuation carries no subject; splitting on it first keeps
  // `男单/女单` from arriving as a single token.
  const normalized = title.replace(PUNCTUATION, ' ');
  for (const raw of cutAll(normalized)) {
    const token = raw.trim().toLowerCase();
    if (token.length < 2) continue;
    if (ZH_STOP_WORDS.has(token)) continue;
    if (!/[\p{Script=Han}a-z0-9]/u.test(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

const PUNCTUATION = /[，。、；：！？（）【】《》「」“”‘’,.;:!?()[\]{}|/\\-]+/g;

/**
 * Containment: shared tokens over the *smaller* set.
 *
 * Jaccard is the wrong measure for titles. `截至2026年10月，最新为 Ubuntu 26.04 LTS`
 * against `Ubuntu 26.04 LTS` shares every token of the shorter title but scores 0.43
 * by Jaccard — it would be missed. Containment asks the question that matters: is one
 * of these titles about the subject of the other?
 */
export function titleContainment(a: string[], b: string[]): number {
  if (a.length < MIN_TITLE_TOKENS || b.length < MIN_TITLE_TOKENS) return 0;
  const smaller = a.length <= b.length ? a : b;
  const largerSet = new Set(a.length <= b.length ? b : a);
  let shared = 0;
  for (const token of smaller) if (largerSet.has(token)) shared += 1;
  return shared / smaller.length;
}

/**
 * Jaccard over **free tags only**.
 *
 * Facets are deliberately excluded, and this is the easiest thing in the file to get
 * wrong: `ftsFacetTokens()` feeds `我写的` / `agent 起草` / the channel name / the
 * project name into the FTS index beside the tags, because they are useful *filters*.
 * They are not useful *relations* — half a library shares them, so scoring over them
 * would link every WebUI note to every other WebUI note. The `tags` column holds only
 * what a human or the model actually wrote.
 *
 * `excluded` extends the same principle to tags that *became* filters by frequency
 * (see `FILTER_TAG_RATIO`): an aspect tag like `pitfall` is useful as a filter and
 * useless as a relation, and it arrives in the same column as the subject tags.
 */
export function tagJaccard(a: string[], b: string[], excluded?: Set<string>): number {
  const setA = new Set(a.map((tag) => tag.trim().toLowerCase()).filter(Boolean));
  const setB = new Set(b.map((tag) => tag.trim().toLowerCase()).filter(Boolean));
  if (excluded)
    for (const tag of excluded) {
      setA.delete(tag);
      setB.delete(tag);
    }
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const tag of setA) if (setB.has(tag)) inter += 1;
  return inter / (setA.size + setB.size - inter);
}

export interface RelationCandidate {
  id: string;
  sessionId: string | null;
  title: string;
  tags: string[];
}

/** Score one pair. Returns null when none of the three rules fires. */
export function scorePair(
  a: RelationCandidate,
  b: RelationCandidate,
  excludedTags?: Set<string>,
): { score: number; basis: RelationBasis } | null {
  if (a.id === b.id) return null;

  // Strongest first, and the first hit wins outright: a session pair that also shares
  // tags is still a session pair, and reporting two bases for one fact would need two
  // rows.
  if (a.sessionId && b.sessionId && a.sessionId === b.sessionId) {
    return { score: 0.9, basis: 'session' };
  }

  if (titleContainment(titleTokens(a.title), titleTokens(b.title)) >= MIN_TITLE_CONTAINMENT) {
    return { score: 0.6, basis: 'title' };
  }

  const jaccard = tagJaccard(a.tags, b.tags, excludedTags);
  if (jaccard >= MIN_TAG_JACCARD) {
    // 0.4 at the floor, approaching 0.7 for a near-identical tag set — always below
    // `title`, because a shared theme is weaker evidence than a shared subject.
    return { score: 0.4 + 0.3 * jaccard, basis: 'tags' };
  }

  return null;
}

interface ScopeNote {
  id: string;
  sessionId: string | null;
  title: string;
  tags: string[];
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * The relation writer for `note_relations`.
 *
 * The unit of consistency is the **scope**, not the note. The exclusion set (which
 * tags are too common to relate through — see `FILTER_TAG_RATIO`) is a property of
 * the scope's live notes as a whole, so the *third* note in a scope can flip a
 * tag that the first two were linked by: a per-note rebuild would leave that stale
 * edge behind on every ordinary write. A scope rebuild recomputes every live pair
 * under one freshly computed set, which makes the table drift-free by construction
 * rather than by a repair script.
 *
 * Scope semantics, deliberately:
 *
 * - **Mirrored rows** — (a→b) and (b→a), same score and basis, so `relatedFor()`
 *   stays a single indexed lookup and the two notes' pages cannot disagree.
 * - **Archived notes keep their rows.** A scope rebuild only replaces rows *between
 *   live notes*; rows touching an archived note survive (hidden at read), which is
 *   what lets un-archiving restore the list for free.
 * - **Capped per note** at `MAX_RELATIONS`, best score first, id as the tiebreak —
 *   the same order the read path uses, so the page never shuffles between writes.
 */
export class NoteRelations {
  constructor(private readonly db: Database.Database) {}

  /**
   * The pairs one note would get, without writing anything.
   *
   * Split out of `rebuildScope()` so `--dry-run` reports the real numbers instead
   * of a second implementation of the rules that could disagree with the writer.
   */
  evaluate(noteId: string): Array<{ relatedId: string; score: number; basis: RelationBasis }> {
    const self = this.liveNote(noteId);
    if (!self) return [];
    const scope = this.liveScopeNotes(self.scope, self.scope_key);
    const mine = scope.find((note) => note.id === noteId);
    if (!mine) return [];
    const excluded = filterTagsOver(scope);

    const scored: Array<{ relatedId: string; score: number; basis: RelationBasis }> = [];
    for (const other of scope) {
      if (other.id === noteId) continue;
      const hit = scorePair(mine, other, excluded);
      if (!hit || hit.score < MIN_SCORE) continue;
      scored.push({ relatedId: other.id, score: hit.score, basis: hit.basis });
    }
    // Score first, id second: a stable order means two notes with the same score do
    // not swap places between runs, which would make the detail page shuffle.
    scored.sort((x, y) => y.score - x.score || x.relatedId.localeCompare(y.relatedId));
    return scored.slice(0, MAX_RELATIONS);
  }

  /** How many relations `rebuild()` would write. Used by `pnpm notes:relate --dry-run`. */
  preview(noteId: string): number {
    return this.evaluate(noteId).length;
  }

  /**
   * Rebuild the scope a note lives in — the write path's entry point.
   *
   * The note itself may be gone (archived or deleted): the scope is still rebuilt,
   * because its *departure* moved the tag ratios for everyone who stays. The
   * return value is the note's own pair count when it is live, else the scope's.
   */
  rebuild(noteId: string, now = Date.now()): number {
    const note = this.db.prepare('SELECT scope, scope_key FROM notes WHERE id = ?').get(noteId) as
      { scope: string; scope_key: string } | undefined;
    if (!note) return 0;
    const written = this.rebuildScope(note.scope, note.scope_key, now);
    return this.liveNote(noteId) ? this.evaluate(noteId).length : written;
  }

  /**
   * Recompute every live pair in one `(scope, scope_key)`.
   *
   * Idempotent: rows between live notes are deleted and rewritten from scratch, so
   * two calls produce the same table — safe on every write and from the backfill
   * script alike. Rows touching non-live notes are left alone (see the class doc).
   */
  rebuildScope(scope: string, scopeKey: string, now = Date.now()): number {
    const notes = this.liveScopeNotes(scope, scopeKey);
    if (notes.length === 0) return 0;

    const excluded = filterTagsOver(notes);
    const pairs = new Map<string, Array<{ other: string; score: number; basis: RelationBasis }>>();
    for (let i = 0; i < notes.length; i += 1) {
      for (let j = i + 1; j < notes.length; j += 1) {
        const hit = scorePair(notes[i]!, notes[j]!, excluded);
        if (!hit || hit.score < MIN_SCORE) continue;
        push(pairs, notes[i]!.id, notes[j]!.id, hit);
        push(pairs, notes[j]!.id, notes[i]!.id, hit);
      }
    }

    const ids = notes.map((note) => note.id);
    const idList = placeholders(ids.length);
    this.db.transaction(() => {
      // Only the live↔live block is replaced; a row touching an archived note
      // survives so restoring that note brings its list back for free.
      this.db
        .prepare(
          `DELETE FROM note_relations
            WHERE note_id IN (${idList}) AND related_id IN (${idList})`,
        )
        .run(...ids, ...ids);
      const insert = this.db.prepare(
        `INSERT OR REPLACE INTO note_relations (note_id, related_id, score, basis, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const note of notes) {
        const mine = (pairs.get(note.id) ?? [])
          .sort((x, y) => y.score - x.score || x.other.localeCompare(y.other))
          .slice(0, MAX_RELATIONS);
        for (const pair of mine) {
          insert.run(note.id, pair.other, pair.score, pair.basis, now);
        }
      }
    })();

    let written = 0;
    for (const mine of pairs.values()) written += Math.min(mine.length, MAX_RELATIONS);
    return written;
  }

  /**
   * Recompute every scope that holds live notes: backfill and drift repair.
   *
   * One `rebuildScope` per distinct `(scope, scope_key)` rather than per note —
   * the same code path the write path uses, so the script and the writer cannot
   * disagree about what a relation is.
   */
  rebuildAll(now = Date.now()): { notes: number; pairs: number } {
    const scopes = this.db
      .prepare(`SELECT DISTINCT scope, scope_key FROM notes WHERE status IN ('active', 'draft')`)
      .all() as Array<{ scope: string; scope_key: string }>;
    let pairs = 0;
    let notes = 0;
    for (const { scope, scope_key } of scopes) {
      notes += this.liveScopeNotes(scope, scope_key).length;
      pairs += this.rebuildScope(scope, scope_key, now);
    }
    return { notes, pairs };
  }

  /** Live notes with no relation rows — what the backfill script targets by default. */
  unlinked(): string[] {
    const rows = this.db
      .prepare(
        `SELECT n.id FROM notes n
          WHERE n.status IN ('active', 'draft')
            AND NOT EXISTS (SELECT 1 FROM note_relations r WHERE r.note_id = n.id)`,
      )
      .all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  /**
   * Delete every row touching a note, both directions.
   *
   * The scope-move path: a note that changed `(scope, scope_key)` has rows pointing
   * at notes neither its old nor its new scope rebuild will list (each only deletes
   * the live↔live block *inside* one scope), so the move clears them explicitly
   * before both scopes are recomputed. Rows to archived neighbours go with them —
   * a moved note's "free restore" list is not worth stale cross-scope edges.
   */
  dropFor(noteId: string): void {
    this.db
      .prepare('DELETE FROM note_relations WHERE note_id = ? OR related_id = ?')
      .run(noteId, noteId);
  }

  private liveNote(noteId: string): { scope: string; scope_key: string } | undefined {
    return this.db
      .prepare(`SELECT scope, scope_key FROM notes WHERE id = ? AND status IN ('active', 'draft')`)
      .get(noteId) as { scope: string; scope_key: string } | undefined;
  }

  /** The scope's live notes with tags parsed, in a stable (id) order. */
  private liveScopeNotes(scope: string, scopeKey: string): ScopeNote[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, title, tags FROM notes
          WHERE scope = ? AND scope_key = ? AND status IN ('active', 'draft')
          ORDER BY id`,
      )
      .all(scope, scopeKey) as Array<{
      id: string;
      session_id: string | null;
      title: string;
      tags: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      title: row.title,
      tags: parseTags(row.tags),
    }));
  }
}

function push(
  pairs: Map<string, Array<{ other: string; score: number; basis: RelationBasis }>>,
  noteId: string,
  other: string,
  hit: { score: number; basis: RelationBasis },
): void {
  let mine = pairs.get(noteId);
  if (!mine) {
    mine = [];
    pairs.set(noteId, mine);
  }
  mine.push({ other, score: hit.score, basis: hit.basis });
}

/** `?, ?, ?` for an `IN (...)` list — every value stays a bound parameter. */
function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

/**
 * The tags the tag rule must ignore for this set of notes: those on ≥
 * `FILTER_TAG_RATIO` of them, once there are at least `FILTER_TAG_MIN_LIVE`.
 *
 * Frequency, never an origin list: `pitfall` is excluded when a third of the
 * scope carries it and not before, and a subject tag everyone genuinely shares
 * (one tool, one project) is excluded by the same rule — which is correct,
 * because at that coverage it links everything to everything too.
 */
function filterTagsOver(notes: ScopeNote[]): Set<string> {
  const df = new Map<string, number>();
  for (const note of notes) {
    for (const tag of new Set(note.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))) {
      df.set(tag, (df.get(tag) ?? 0) + 1);
    }
  }
  const excluded = new Set<string>();
  if (notes.length < FILTER_TAG_MIN_LIVE) return excluded;
  for (const [tag, count] of df) {
    if (count / notes.length >= FILTER_TAG_RATIO) excluded.add(tag);
  }
  return excluded;
}
