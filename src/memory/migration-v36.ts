/**
 * Migration v36: drop `notes.kind`, move the aspect dimension into tags.
 *
 * `kind` was a stored classification that changed no behaviour: the UI never sent
 * the `?kind=` filter, the FTS index did not include it, no policy read it, and
 * the per-kind field whitelist only ever filtered model output (the HTTP layer
 * already accepted free field keys). What the dimension was actually for —
 * "show me every pitfall" — belongs to tags, where the facet filter, the FTS
 * index and the tag counts all really consume it.
 *
 * What this migration does, in order:
 *
 *   1. **Backfill** — every row whose kind maps to an aspect tag gains that tag
 *      (`pitfall` → `pitfall`, `insight` → `opinion`, `other`/unknown → nothing).
 *      The aspect tag is appended, never evicting a subject tag: a row already
 *      carrying six tags keeps them all and simply loses the aspect.
 *   2. **Re-index** the FTS rows of the notes whose tags changed, or searching
 *      `pitfall` after the upgrade would miss every note that predates it.
 *   3. **Rebuild relations** — the tag rule's scores changed twice (new aspect
 *      tags, and the frequency exclusion `relations.ts` now applies to them), and
 *      `rebuildAll()` is the same code path the write path and `pnpm notes:relate`
 *      use, so drift is impossible by construction.
 *   4. **Drop** `idx_notes_kind` then the `kind` column itself (SQLite ≥ 3.35;
 *      DROP COLUMN refuses while an index still references the column).
 *
 * Replay-safe: everything is guarded on the `kind` column existing, so a database
 * that already migrated (or a fresh one created by v31 + this migration in the
 * same boot) finds nothing to do.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../app/logger.js';
import { indexNote } from '../notes/indexer.js';
import { ftsFacetTokens } from '../notes/facets.js';
import { NoteRelations } from '../notes/relations.js';

const logger = createLogger();

export interface MigrateV36Result {
  /** True when the `kind` column existed and this call removed it. */
  dropped: boolean;
  /** Rows that gained an aspect tag. */
  retagged: number;
}

/** Max tags a note may carry — mirrors `normalizeTags`, which is not imported to keep this self-contained at boot. */
const MAX_TAGS = 6;

/** The old closed set → the aspect tag vocabulary the distiller prompt now fixes. */
const KIND_TO_ASPECT: Record<string, string> = {
  command: 'command',
  workflow: 'workflow',
  pitfall: 'pitfall',
  reference: 'reference',
  decision: 'decision',
  opinion: 'opinion',
  insight: 'opinion',
};

interface NoteBackfillRow {
  id: string;
  kind: string;
  title: string;
  summary: string;
  body: string;
  tags: string | null;
  status: string;
  scope: string;
  scope_key: string;
  origin: string;
  channel: string | null;
}

export function migrateV36(db: Database.Database): MigrateV36Result {
  const columns = db.prepare('PRAGMA table_info(notes)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'kind')) {
    return { dropped: false, retagged: 0 };
  }

  const rows = db
    .prepare(
      'SELECT id, kind, title, summary, body, tags, status, scope, scope_key, origin, channel FROM notes',
    )
    .all() as NoteBackfillRow[];

  const retag = db.prepare('UPDATE notes SET tags = ? WHERE id = ?');
  const retagged: NoteBackfillRow[] = [];
  /** Lazily prepared: `projects` exists on every real database, but this migration
   * must not *require* it to drop a column. */
  let projectNameStatement: ReturnType<Database.Database['prepare']> | undefined;

  db.transaction(() => {
    for (const row of rows) {
      const aspect = KIND_TO_ASPECT[row.kind];
      if (!aspect) continue; // `other`, garbage, or already an aspect-only value
      let tags: string[] = [];
      try {
        const parsed: unknown = row.tags ? JSON.parse(row.tags) : [];
        if (Array.isArray(parsed)) {
          tags = parsed.filter((tag): tag is string => typeof tag === 'string');
        }
      } catch {
        // A malformed tags column is corrupt data; leaving it alone is safer
        // than writing over it with a half-understood array.
        continue;
      }
      if (tags.map((tag) => tag.toLowerCase()).includes(aspect)) continue;
      if (tags.length >= MAX_TAGS) continue; // subjects keep their slots
      const next = [...tags, aspect];
      retag.run(JSON.stringify(next), row.id);
      retagged.push({ ...row, tags: JSON.stringify(next) });
    }

    // The FTS `tags` column is the union of stored tags and facet tokens, so a
    // retagged note is invisible to aspect searches until its row is replaced.
    for (const row of retagged) {
      const tags: string[] = JSON.parse(row.tags ?? '[]') as string[];
      let name: string | null = null;
      if (row.scope === 'project' && row.scope_key) {
        projectNameStatement ??= db.prepare('SELECT name FROM projects WHERE id = ?');
        name =
          (projectNameStatement.get(row.scope_key) as { name: string } | undefined)?.name ?? null;
      }
      indexNote(db, {
        id: row.id,
        status: row.status === 'draft' || row.status === 'archived' ? row.status : 'active',
        scope: row.scope,
        scopeKey: row.scope_key,
        title: row.title,
        summary: row.summary,
        body: row.body,
        indexTags: [
          ...tags,
          ...ftsFacetTokens({
            origin: row.origin === 'agent' ? 'agent' : 'user',
            channel:
              row.channel &&
              ['feishu', 'telegram', 'wechat', 'qq', 'webui', 'cron'].includes(row.channel)
                ? (row.channel as 'feishu' | 'telegram' | 'wechat' | 'qq' | 'webui' | 'cron')
                : null,
            projectName: name,
          }),
        ],
      });
    }

    // New aspect tags would create edges the old rows never had (and the
    // frequency rule removes others); one rebuild keeps the table honest.
    try {
      new NoteRelations(db).rebuildAll();
    } catch (err) {
      // Drift, not data loss: `pnpm notes:relate --all` repairs it with the same
      // code, and a boot must not die over a derived table.
      logger.warn({ err }, '[V36] note_relations rebuild failed — run pnpm notes:relate --all');
    }

    // Index first, column second: DROP COLUMN refuses while idx_notes_kind
    // still references `kind`, so the index goes before the column.
    db.exec('DROP INDEX IF EXISTS idx_notes_kind');
    db.exec('ALTER TABLE notes DROP COLUMN kind');
  })();

  if (retagged.length > 0) {
    logger.info(
      `[V36] notes.kind dropped; ${retagged.length} note(s) gained an aspect tag, FTS and relations rebuilt`,
    );
  } else {
    logger.info('[V36] notes.kind dropped; no row needed an aspect tag');
  }
  return { dropped: true, retagged: retagged.length };
}
