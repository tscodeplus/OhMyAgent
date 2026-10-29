/**
 * Migration v22 + the scope model: a page belongs to a conversation.
 *
 * What this file pins, and the failure each one prevents:
 *
 * 1. `scope` is added on an upgraded database and defaults every existing page to
 *    `'global'` — the upgrade must not hide a single page behind a scope nobody
 *    reads. The column is `NOT NULL`, so no row can be readable as NULL.
 * 2. Re-running is a no-op: `ALTER TABLE ADD COLUMN` throws on the second pass,
 *    and this migration runs on every open.
 * 3. The slug uniqueness **widens** to include scope. This is the subtle one: the
 *    index keeps its name, so `CREATE INDEX IF NOT EXISTS` would silently leave
 *    `(page_type, slug)` in place and two chats could still not hold one subject.
 *    The rebuild is driven by `PRAGMA index_info`.
 * 4. Read visibility is `scope = asked OR scope = 'global'`, never equality —
 *    equality would hide every console-written page from every chat.
 * 5. `scopeFromContext` prefers the *chat* over the session: scoping to a session
 *    would hide a group's own page from the next turn in that same group.
 */

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrateV14 } from '../../src/memory/migration-v14.js';
import { migrateV22 } from '../../src/memory/migration-v22.js';
import {
  SCOPE_GLOBAL,
  isVisibleInScope,
  normalizeScope,
  scopeFromContext,
} from '../../src/memory/knowledge/scope.js';

const open: Database.Database[] = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function fresh(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateV14(db);
  open.push(db);
  return db;
}

function indexColumns(db: Database.Database, index: string): string[] {
  return (db.prepare(`PRAGMA index_info(${index})`).all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

function insertPage(db: Database.Database, slug: string, title = slug): void {
  db.prepare(
    `INSERT INTO knowledge_pages (id, page_type, slug, title, content, version, status)
     VALUES (?, 'topic', ?, ?, 'body', 1, 'active')`,
  ).run(`id-${slug}-${Math.random().toString(36).slice(2)}`, slug, title);
}

describe('migration v22', () => {
  it('adds a NOT NULL scope defaulting to global, so no page is hidden by upgrade', () => {
    const db = fresh();
    insertPage(db, 'deploy-process');

    const result = migrateV22(db);
    expect(result.added).toEqual(['scope']);

    const row = db
      .prepare('SELECT scope FROM knowledge_pages WHERE slug = ?')
      .get('deploy-process');
    expect(row).toEqual({ scope: 'global' });
  });

  it('widens slug uniqueness to include the scope instead of leaving the narrow index', () => {
    const db = fresh();
    expect(indexColumns(db, 'idx_knowledge_pages_slug')).toEqual(['page_type', 'slug']);

    migrateV22(db);

    expect(indexColumns(db, 'idx_knowledge_pages_slug')).toEqual(['page_type', 'scope', 'slug']);
    // The behavioural consequence: two chats can now hold the same subject.
    db.prepare(
      `INSERT INTO knowledge_pages (id, page_type, slug, title, content, version, status, scope)
       VALUES ('a', 'topic', 'deploy', 'Deploy', 'chat A', 1, 'active', 'feishu:oc_a')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO knowledge_pages (id, page_type, slug, title, content, version, status, scope)
           VALUES ('b', 'topic', 'deploy', 'Deploy', 'chat B', 1, 'active', 'telegram:42')`,
        )
        .run(),
    ).not.toThrow();
    // ...while a duplicate inside one scope is still refused.
    expect(() =>
      db
        .prepare(
          `INSERT INTO knowledge_pages (id, page_type, slug, title, content, version, status, scope)
           VALUES ('c', 'topic', 'deploy', 'Deploy', 'again', 1, 'active', 'feishu:oc_a')`,
        )
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it('is a no-op when re-run, because every migration replays on open', () => {
    const db = fresh();
    migrateV22(db);
    const second = migrateV22(db);
    expect(second).toEqual({ added: [], created: [] });
  });

  it('does nothing at all when the knowledge layer does not exist', () => {
    const db = new Database(':memory:');
    open.push(db);
    expect(migrateV22(db)).toEqual({ added: [], created: [] });
  });
});

describe('scope model', () => {
  it('folds casing and whitespace so one chat cannot become two scopes', () => {
    expect(normalizeScope('Feishu:OC_1')).toBe('feishu:oc_1');
    expect(normalizeScope('  feishu  oc_1 ')).toBe('feishu-oc_1');
    expect(normalizeScope('')).toBe(SCOPE_GLOBAL);
    expect(normalizeScope(undefined)).toBe(SCOPE_GLOBAL);
    expect(normalizeScope('global')).toBe(SCOPE_GLOBAL);
  });

  it('prefers the chat over the session, and falls back to global without either', () => {
    expect(scopeFromContext({ channel: 'feishu', chatId: 'oc_1', sessionId: 's1' })).toBe(
      'feishu:oc_1',
    );
    // A channel session with no chat id is still one conversation, not a broadcast.
    expect(scopeFromContext({ channel: 'telegram', sessionId: 's1' })).toBe('telegram:session:s1');
    expect(scopeFromContext({ sessionId: 's1' })).toBe('session:s1');
    // The console (WebUI, cron) has no channel and no session: global.
    expect(scopeFromContext({})).toBe(SCOPE_GLOBAL);
    expect(scopeFromContext(undefined)).toBe(SCOPE_GLOBAL);
  });

  it('folds the console channel to global, because a console is not a conversation', () => {
    // The WebUI does pass a channel and a chat id (`webui`, `webui:<project>`),
    // yet a page a human writes or approves there is the authority for the
    // whole install: scoping it to one project would make it a page no chat
    // ever reads.
    expect(scopeFromContext({ channel: 'webui', chatId: 'webui:proj_1' })).toBe(SCOPE_GLOBAL);
    expect(scopeFromContext({ channel: 'WebUI', sessionId: 's1' })).toBe(SCOPE_GLOBAL);
    // Any other channel keeps its scope.
    expect(scopeFromContext({ channel: 'feishu', chatId: 'oc_1' })).toBe('feishu:oc_1');
  });

  it('lets a chat read its own pages and globals, and nothing else', () => {
    expect(isVisibleInScope('feishu:oc_1', 'feishu:oc_1')).toBe(true);
    expect(isVisibleInScope('global', 'feishu:oc_1')).toBe(true);
    expect(isVisibleInScope('feishu:oc_2', 'feishu:oc_1')).toBe(false);
    // A page written before the column existed (NULL) reads as global.
    expect(isVisibleInScope(null, 'feishu:oc_1')).toBe(true);
  });
});
