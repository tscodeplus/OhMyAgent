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
 *      `tagJaccard()`.
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
 */
export function tagJaccard(a: string[], b: string[]): number {
  const setA = new Set(a.map((tag) => tag.trim().toLowerCase()).filter(Boolean));
  const setB = new Set(b.map((tag) => tag.trim().toLowerCase()).filter(Boolean));
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

  const jaccard = tagJaccard(a.tags, b.tags);
  if (jaccard >= MIN_TAG_JACCARD) {
    // 0.4 at the floor, approaching 0.7 for a near-identical tag set — always below
    // `title`, because a shared theme is weaker evidence than a shared subject.
    return { score: 0.4 + 0.3 * jaccard, basis: 'tags' };
  }

  return null;
}

interface NoteRelationRow {
  id: string;
  session_id: string | null;
  title: string;
  tags: string | null;
  scope: string;
  scope_key: string;
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
 * Recompute the relations of one note.
 *
 * Idempotent: the note's rows are deleted (both directions) and rebuilt, so two calls
 * produce the same table. That is what makes it safe to run on every write *and* from
 * the backfill script.
 *
 * Rows are **mirrored** — (a→b) and (b→a), same score and basis. One extra row per
 * pair buys two things: `relatedFor()` stays a single indexed lookup on `note_id`, and
 * when a new note arrives the *older* note's side is written in the same transaction,
 * so it sees the new neighbour immediately instead of waiting for a full recompute.
 * The mirroring invariant is "if a→b exists then b→a exists", and every delete in this
 * class maintains it.
 */
export class NoteRelations {
  constructor(private readonly db: Database.Database) {}

  /**
   * The pairs one note would get, without writing anything.
   *
   * Split out of `rebuild()` so `--dry-run` reports the real numbers instead of a
   * second implementation of the rules that could disagree with the writing one.
   */
  evaluate(noteId: string): Array<{ relatedId: string; score: number; basis: RelationBasis }> {
    const self = this.liveNote(noteId);
    if (!self) return [];

    const mine: RelationCandidate = {
      id: self.id,
      sessionId: self.session_id,
      title: self.title,
      tags: parseTags(self.tags),
    };

    // One scoped query, scored in JS. The scope predicate is what keeps this small and
    // is answered by `idx_notes_scope`; the three rules are cheap string work over a
    // few dozen rows, so pushing them into SQL would trade clarity for nothing.
    const candidates = this.db
      .prepare(
        `SELECT id, session_id, title, tags, scope, scope_key FROM notes
          WHERE scope = ? AND scope_key = ? AND id <> ? AND status IN ('active', 'draft')`,
      )
      .all(self.scope, self.scope_key, self.id) as NoteRelationRow[];

    const scored: Array<{ relatedId: string; score: number; basis: RelationBasis }> = [];
    for (const row of candidates) {
      const hit = scorePair(mine, {
        id: row.id,
        sessionId: row.session_id,
        title: row.title,
        tags: parseTags(row.tags),
      });
      if (!hit || hit.score < MIN_SCORE) continue;
      scored.push({ relatedId: row.id, score: hit.score, basis: hit.basis });
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

  /** Rebuild one note. Called inside the note write's transaction. */
  rebuild(noteId: string, now = Date.now()): number {
    const self = this.liveNote(noteId);
    if (!self) {
      // Archived or gone: drop its rows rather than leaving edges the read path would
      // have to filter anyway.
      this.dropPairs(noteId);
      return 0;
    }

    const kept = this.evaluate(noteId);

    this.db.transaction(() => {
      this.dropPairs(self.id);
      const insert = this.db.prepare(
        `INSERT OR REPLACE INTO note_relations (note_id, related_id, score, basis, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const { relatedId, score, basis } of kept) {
        insert.run(self.id, relatedId, score, basis, now);
        insert.run(relatedId, self.id, score, basis, now);
      }
      // The neighbours gained a row too; trim each back to MAX_RELATIONS so a note that
      // already had five strong relations does not accumulate weak ones.
      for (const { relatedId } of kept) this.trim(relatedId);
    })();

    return kept.length;
  }

  /**
   * Recompute every active/draft note: backfill and drift repair.
   *
   * The same code path as `rebuild()`, so the script and the write path cannot
   * disagree about what a relation is.
   */
  rebuildAll(now = Date.now()): { notes: number; pairs: number } {
    const ids = this.db
      .prepare(`SELECT id FROM notes WHERE status IN ('active', 'draft')`)
      .all() as Array<{ id: string }>;
    let pairs = 0;
    for (const { id } of ids) pairs += this.rebuild(id, now);
    return { notes: ids.length, pairs };
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

  private liveNote(noteId: string): NoteRelationRow | undefined {
    return this.db
      .prepare(
        `SELECT id, session_id, title, tags, scope, scope_key FROM notes
          WHERE id = ? AND status IN ('active', 'draft')`,
      )
      .get(noteId) as NoteRelationRow | undefined;
  }

  /** Delete a note's rows in both directions (the mirroring invariant). */
  private dropPairs(noteId: string): void {
    this.db
      .prepare('DELETE FROM note_relations WHERE note_id = ? OR related_id = ?')
      .run(noteId, noteId);
  }

  /**
   * Keep one note's best `MAX_RELATIONS` rows.
   *
   * The dropped pairs are deleted **in both directions**: leaving the mirror behind
   * would make a→b and b→a disagree about whether the pair exists, and the two notes'
   * pages would show different lists for the same fact.
   */
  private trim(noteId: string): void {
    const extra = this.db
      .prepare(
        `SELECT related_id FROM note_relations
          WHERE note_id = ? ORDER BY score DESC, related_id ASC LIMIT -1 OFFSET ${MAX_RELATIONS}`,
      )
      .all(noteId) as Array<{ related_id: string }>;
    if (extra.length === 0) return;
    const drop = this.db.prepare(
      `DELETE FROM note_relations
        WHERE (note_id = ? AND related_id = ?) OR (note_id = ? AND related_id = ?)`,
    );
    for (const { related_id: relatedId } of extra) {
      drop.run(noteId, relatedId, relatedId, noteId);
    }
  }
}
