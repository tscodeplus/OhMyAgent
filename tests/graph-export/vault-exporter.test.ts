import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema';
import { migrateV14 } from '../../src/memory/migration-v14';
import { migrateV22 } from '../../src/memory/migration-v22';
import {
  ENTITY_TABLES_ABSENT_NOTICE,
  VAULT_STATE_FILE,
  exportVault,
} from '../../src/graph-export/vault-exporter';
import { parseAliases } from '../../src/graph-export/entity-tables';
import {
  VaultPathError,
  isGeneratedNotePath,
  safeJoin,
  safeFileStem,
  slugifySegment,
} from '../../src/graph-export/slug';

const CREATED_AT = 1735689600000; // 2025-01-01T00:00:00Z
const UPDATED_AT = 1735776000000; // 2025-01-02T00:00:00Z

let tmpDir: string;
let dbPath: string;
let db: Database.Database;
let outDir: string;

function insertMemory(
  id: string,
  content: string,
  extra: { kind?: string; status?: string; updatedAt?: number } = {},
): void {
  db.prepare(
    `INSERT INTO memories (id, scope, scope_key, kind, content, status, confidence, created_at, updated_at)
     VALUES (?, 'user', 'u-1', ?, ?, ?, 0.9, ?, ?)`,
  ).run(
    id,
    extra.kind ?? 'fact',
    content,
    extra.status ?? 'active',
    CREATED_AT,
    extra.updatedAt ?? UPDATED_AT,
  );
}

function insertMemoryLink(
  id: string,
  memoryId: string,
  target: string,
  relation = 'mentions',
  confidence = 0.9,
): void {
  db.prepare(
    `INSERT INTO memory_links (id, source_memory_id, target_entity, relation_type, confidence)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, memoryId, target, relation, confidence);
}

function insertSessionWithEpisode(id: string, summary: string): void {
  db.prepare(
    `INSERT INTO sessions (id, chat_id, user_id, created_at, updated_at) VALUES (?, 'chat-1', 'u-1', ?, ?)`,
  ).run(id, CREATED_AT, UPDATED_AT);
  db.prepare(`INSERT INTO episodes (id, session_id, summary, created_at) VALUES (?, ?, ?, ?)`).run(
    `ep-${id}`,
    id,
    summary,
    UPDATED_AT,
  );
}

/** Entity tables as introduced by the memory entity-graph migration. */
function createEntityTables(): void {
  db.exec(`
    CREATE TABLE entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      entity_type TEXT,
      description TEXT,
      aliases TEXT,
      updated_at INTEGER
    );
    CREATE TABLE entity_edges (
      id TEXT PRIMARY KEY,
      source_entity_id TEXT NOT NULL,
      target_entity_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      confidence REAL
    );
    CREATE TABLE entity_aliases (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      alias TEXT NOT NULL
    );
  `);
}

function insertEntity(
  id: string,
  name: string,
  options: { entityType?: string; description?: string; aliases?: string[] } = {},
): void {
  db.prepare(
    `INSERT INTO entities (id, name, entity_type, description, aliases, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    options.entityType ?? 'person',
    options.description ?? `${name} description`,
    options.aliases ? JSON.stringify(options.aliases) : '[]',
    UPDATED_AT,
  );
}

function insertEdge(
  id: string,
  fromId: string,
  toId: string,
  relation: string,
  confidence: number,
): void {
  db.prepare(
    `INSERT INTO entity_edges (id, source_entity_id, target_entity_id, relation, confidence)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, fromId, toId, relation, confidence);
}

/** Every file under `root`, vault-relative POSIX path → content. */
function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      files[relative] = fs.readFileSync(absolute, 'utf8');
    }
  };
  if (fs.existsSync(root)) walk(root);
  return files;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-vault-export-'));
  dbPath = path.join(tmpDir, 'app.db');
  outDir = path.join(tmpDir, 'vault');
  db = new Database(dbPath);
  applySchema(db);
});

afterEach(() => {
  if (db.open) db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('exportVault — layout and frontmatter', () => {
  it('projects active memories and session summaries when entity tables are absent', () => {
    insertMemory('mem-1', 'Likes espresso in the morning', { kind: 'preference' });
    insertMemory('mem-2', 'Old superseded fact', { status: 'superseded' });
    insertMemoryLink('link-1', 'mem-1', 'Alice', 'likes', 0.8);
    insertSessionWithEpisode('sess-1', 'Talked about coffee brewing');

    const result = exportVault({ db, outDir });

    expect(result.entityTablesPresent).toBe(false);
    expect(result.notes).toEqual([ENTITY_TABLES_ABSENT_NOTICE]);
    expect(result.written.sort()).toEqual(
      ['index.md', 'memories/mem-1.md', 'sessions/sess-1.md'].sort(),
    );

    const memoryNote = fs.readFileSync(path.join(outDir, 'memories', 'mem-1.md'), 'utf8');
    expect(memoryNote).toContain('---\nid: mem-1\n');
    expect(memoryNote).toContain('kind: preference');
    expect(memoryNote).toContain('scope_key: u-1');
    expect(memoryNote).toContain('status: active');
    expect(memoryNote).toContain('updated_at: 2025-01-02T00:00:00.000Z');
    expect(memoryNote).toContain('Likes espresso in the morning');
    // No entity notes exist, so the link is plain text rather than a dead wikilink.
    expect(memoryNote).toContain('## Entities');
    expect(memoryNote).toContain('- Alice — likes (confidence 0.80)');

    const sessionNote = fs.readFileSync(path.join(outDir, 'sessions', 'sess-1.md'), 'utf8');
    expect(sessionNote).toContain('Talked about coffee brewing');

    const index = fs.readFileSync(path.join(outDir, 'index.md'), 'utf8');
    expect(index).toContain('| Memories | 1 |');
    expect(index).toContain('| Entities | 0 |');
    expect(index).toContain('memories/mem-1');
    expect(index).toContain('Entity tables are not present');

    // Superseded rows are database tombstones, not knowledge.
    expect(fs.existsSync(path.join(outDir, 'memories', 'mem-2.md'))).toBe(false);
    expect(fs.existsSync(path.join(outDir, 'entities'))).toBe(false);

    const state = JSON.parse(fs.readFileSync(path.join(outDir, VAULT_STATE_FILE), 'utf8'));
    expect(state.files).toEqual(['index.md', 'memories/mem-1.md', 'sessions/sess-1.md']);
  });

  it('projects entities, relations and back-links when entity tables exist', () => {
    createEntityTables();
    insertEntity('ent-1', 'Alice Smith', { aliases: ['Al'] });
    insertEntity('ent-2', 'Bob Jones', { entityType: 'person' });
    insertEdge('edge-1', 'ent-1', 'ent-2', 'knows', 0.9);
    db.prepare(
      `INSERT INTO entity_aliases (id, entity_id, alias) VALUES ('alias-1', 'ent-1', 'A. Smith')`,
    ).run();
    insertMemory('mem-1', 'Alice Smith met Bob Jones at the conference');
    insertMemoryLink('link-1', 'mem-1', 'Alice Smith', 'mentions', 0.7);

    const result = exportVault({ db, outDir });

    expect(result.entityTablesPresent).toBe(true);
    expect(result.notes).toEqual([]);
    expect(fs.existsSync(path.join(outDir, 'entities', 'alice-smith.md'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'entities', 'bob-jones.md'))).toBe(true);

    const aliceNote = fs.readFileSync(path.join(outDir, 'entities', 'alice-smith.md'), 'utf8');
    expect(aliceNote).toContain('id: ent-1');
    expect(aliceNote).toContain('entity_type: person');
    expect(aliceNote).toContain('updated_at: 2025-01-02T00:00:00.000Z');
    expect(aliceNote).toContain('aliases:');
    expect(aliceNote).toContain('Alice Smith'); // canonical name resolves `[[Alice Smith]]`
    expect(aliceNote).toContain('A. Smith');
    expect(aliceNote).toContain('Alice Smith description');
    expect(aliceNote).toContain('### Outgoing');
    expect(aliceNote).toContain('- [[Bob Jones]] — knows (confidence 0.90)');
    expect(aliceNote).toContain('## Source memories');
    expect(aliceNote).toContain('memories/mem-1');

    const bobNote = fs.readFileSync(path.join(outDir, 'entities', 'bob-jones.md'), 'utf8');
    expect(bobNote).toContain('### Incoming');
    expect(bobNote).toContain('- [[Alice Smith]] — knows (confidence 0.90)');

    const memoryNote = fs.readFileSync(path.join(outDir, 'memories', 'mem-1.md'), 'utf8');
    expect(memoryNote).toContain('## Entities');
    expect(memoryNote).toContain('- [[Alice Smith]] — mentions (confidence 0.70)');

    const index = fs.readFileSync(path.join(outDir, 'index.md'), 'utf8');
    expect(index).toContain('| Entities | 2 |');
    expect(index).toContain('| Relations | 1 |');
    expect(index).toContain('- [[Alice Smith]] — person');
  });
});

describe('exportVault — idempotency', () => {
  it('produces byte-identical files and reports zero changes on a second run', () => {
    createEntityTables();
    insertEntity('ent-1', 'Alice Smith');
    insertMemory('mem-1', 'Likes espresso');
    insertSessionWithEpisode('sess-1', 'Coffee talk');

    const first = exportVault({ db, outDir });
    const firstSnapshot = snapshot(outDir);
    expect(first.written.length).toBeGreaterThan(0);

    const second = exportVault({ db, outDir });
    const secondSnapshot = snapshot(outDir);

    expect(second.written).toEqual([]);
    expect(second.deleted).toEqual([]);
    expect(second.unchanged.sort()).toEqual(first.written.sort());
    expect(secondSnapshot).toEqual(firstSnapshot);
  });

  it('rewrites a generated note that was edited by hand', () => {
    insertMemory('mem-1', 'Likes espresso');
    exportVault({ db, outDir });

    const notePath = path.join(outDir, 'memories', 'mem-1.md');
    fs.writeFileSync(notePath, 'tampered content\n', 'utf8');

    const result = exportVault({ db, outDir });
    expect(result.written).toContain('memories/mem-1.md');
    expect(fs.readFileSync(notePath, 'utf8')).toContain('Likes espresso');
  });
});

describe('exportVault — stale generated notes and manual notes', () => {
  it('deletes notes whose backing row disappeared and never touches manual/**', () => {
    insertMemory('mem-1', 'Likes espresso');
    insertMemory('mem-2', 'Dislikes tea');

    fs.mkdirSync(path.join(outDir, 'manual'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'manual', 'my-note.md'), '# hand written\n', 'utf8');
    fs.writeFileSync(path.join(outDir, 'loose-note.md'), '# also mine\n', 'utf8');

    const first = exportVault({ db, outDir });
    expect(first.written).toContain('memories/mem-2.md');

    // Row becomes inactive (superseded) — the vault must follow the database.
    db.prepare("UPDATE memories SET status = 'superseded' WHERE id = 'mem-2'").run();

    const second = exportVault({ db, outDir });

    expect(second.deleted).toEqual(['memories/mem-2.md']);
    expect(fs.existsSync(path.join(outDir, 'memories', 'mem-2.md'))).toBe(false);
    expect(fs.existsSync(path.join(outDir, 'memories', 'mem-1.md'))).toBe(true);
    expect(fs.readFileSync(path.join(outDir, 'manual', 'my-note.md'), 'utf8')).toBe(
      '# hand written\n',
    );
    expect(fs.readFileSync(path.join(outDir, 'loose-note.md'), 'utf8')).toBe('# also mine\n');

    const state = JSON.parse(fs.readFileSync(path.join(outDir, VAULT_STATE_FILE), 'utf8'));
    expect(state.files).toEqual(['index.md', 'memories/mem-1.md']);
  });

  it('stops generating entity notes when the entity tables disappear', () => {
    createEntityTables();
    insertEntity('ent-1', 'Alice Smith');
    insertMemory('mem-1', 'Alice Smith likes espresso');

    exportVault({ db, outDir });
    expect(fs.existsSync(path.join(outDir, 'entities', 'alice-smith.md'))).toBe(true);

    db.exec('DROP TABLE entity_edges; DROP TABLE entity_aliases; DROP TABLE entities;');

    const result = exportVault({ db, outDir });
    expect(result.entityTablesPresent).toBe(false);
    expect(result.deleted).toEqual(['entities/alice-smith.md']);
    expect(fs.existsSync(path.join(outDir, 'entities', 'alice-smith.md'))).toBe(false);
  });

  it('ignores a state file that lists paths outside the generated namespace', () => {
    insertMemory('mem-1', 'Likes espresso');
    fs.mkdirSync(path.join(outDir, 'manual'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'manual', 'my-note.md'), '# hand written\n', 'utf8');
    fs.writeFileSync(
      path.join(outDir, VAULT_STATE_FILE),
      JSON.stringify({ version: 1, files: ['manual/my-note.md', '../escape.md'] }),
      'utf8',
    );

    const result = exportVault({ db, outDir });

    expect(result.deleted).toEqual([]);
    expect(fs.existsSync(path.join(outDir, 'manual', 'my-note.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'escape.md'))).toBe(false);
  });
});

describe('exportVault — path safety', () => {
  const payload = '../../etc/passwd';

  it('slugifies traversal payloads and keeps every note inside the vault', () => {
    createEntityTables();
    insertEntity('ent-1', payload);
    insertMemory(payload, 'A memory whose id looks like a path');
    insertMemoryLink('link-1', payload, payload);

    const result = exportVault({ db, outDir });

    expect(result.written.length).toBeGreaterThan(0);

    // Nothing was created outside the vault, and every note is a plain file
    // directly under its generated directory.
    const vaultFiles = Object.keys(snapshot(outDir));
    for (const file of vaultFiles) {
      expect(file.includes('..')).toBe(false);
      expect(
        file.startsWith('memories/') || file.startsWith('entities/') || !file.includes('/'),
      ).toBe(true);
      expect(file.split('/').length).toBeLessThanOrEqual(2);
    }
    expect(fs.existsSync(path.join(tmpDir, 'etc'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '..', 'etc', 'passwd'))).toBe(false);

    const memoryNotes = vaultFiles.filter((file) => file.startsWith('memories/'));
    expect(memoryNotes).toEqual([`memories/${slugifySegment(payload)}.md`]);
    const entityNotes = vaultFiles.filter((file) => file.startsWith('entities/'));
    expect(entityNotes).toEqual([`entities/${slugifySegment(payload)}.md`]);
  });

  it('never lets a raw segment escape the vault root', () => {
    expect(slugifySegment('../../etc/passwd')).toBe('etc-passwd');
    expect(slugifySegment('/etc/passwd')).toBe('etc-passwd');
    expect(slugifySegment('C:\\Windows\\System32')).toBe('c-windows-system32');
    expect(slugifySegment('CON')).toBe('');
    expect(safeFileStem('CON')).toMatch(/^note-[0-9a-f]{8}$/);
    expect(safeJoin(tmpDir, 'vault', 'index.md')).toBe(path.join(tmpDir, 'vault', 'index.md'));
    expect(() => safeJoin(tmpDir, '..', 'etc', 'passwd')).toThrow(VaultPathError);
  });

  it('keeps CJK and latin names readable while dropping separators', () => {
    expect(slugifySegment('张三')).toBe('张三');
    expect(slugifySegment('Alice Smith')).toBe('alice-smith');
    expect(slugifySegment('  Mixed 名字 42 ')).toBe('mixed-名字-42');
    expect(safeFileStem('🎉')).toMatch(/^note-[0-9a-f]{8}$/);
    expect(safeFileStem('🎉')).toBe(safeFileStem('🎉'));
  });
});

describe('exportVault — dry run and read-only database', () => {
  it('reports the plan without writing anything', () => {
    insertMemory('mem-1', 'Likes espresso');

    const result = exportVault({ db, outDir, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.written.sort()).toEqual(['index.md', 'memories/mem-1.md'].sort());
    expect(fs.existsSync(outDir)).toBe(false);
  });

  it('works against a readonly connection, so it cannot author memory', () => {
    insertMemory('mem-1', 'Likes espresso');
    const readonlyDb = new Database(dbPath, { readonly: true });
    try {
      expect(() => readonlyDb.prepare('DELETE FROM memories').run()).toThrow();
      const result = exportVault({ db: readonlyDb, outDir });
      expect(result.written).toContain('memories/mem-1.md');
      expect(db.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 1 });
    } finally {
      readonlyDb.close();
    }
  });
});

describe('exportVault — knowledge page layer', () => {
  const UPDATED_PAGE_AT = 1735862400000; // 2025-01-03T00:00:00Z

  function insertPage(row: {
    id: string;
    slug: string;
    title: string;
    content: string;
    pageType?: string;
    status?: string;
    version?: number;
    tags?: string[];
    aliases?: string[];
    /** Omitted means `global`: the column's default, as before the v22 migration. */
    scope?: string;
    sources?: Array<{ kind: string; id: string }>;
  }): void {
    db.prepare(
      `INSERT INTO knowledge_pages
         (id, page_type, slug, title, content, aliases, tags, confidence,
          version, status, scope, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0.9, ?, ?, ?, ?, ?, 'user')`,
    ).run(
      row.id,
      row.pageType ?? 'topic',
      row.slug,
      row.title,
      row.content,
      row.aliases ? JSON.stringify(row.aliases) : null,
      row.tags ? JSON.stringify(row.tags) : null,
      row.version ?? 1,
      row.status ?? 'active',
      row.scope ?? 'global',
      CREATED_AT,
      UPDATED_PAGE_AT,
    );
    for (const source of row.sources ?? []) {
      db.prepare(
        `INSERT INTO knowledge_sources (page_id, source_kind, source_id, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(row.id, source.kind, source.id, CREATED_AT);
    }
  }

  beforeEach(() => {
    migrateV14(db);
    migrateV22(db);
  });

  it('writes one note per active page at pages/<page_type>/<slug>.md', () => {
    insertPage({
      id: 'page-1',
      pageType: 'topic',
      slug: 'power-query',
      title: 'Power Query',
      content: 'Power Query is how the monthly ETL runs.\n',
      version: 3,
      tags: ['etl', 'excel'],
      aliases: ['PQ'],
      sources: [
        { kind: 'memory', id: 'mem-1' },
        { kind: 'message', id: 'msg-1' },
      ],
    });
    insertPage({
      id: 'page-2',
      pageType: 'project',
      slug: 'excel-etl',
      title: 'Excel ETL',
      content: 'The pipeline project.',
      sources: [{ kind: 'memory', id: 'mem-1' }],
    });

    const result = exportVault({ db, outDir });

    expect(result.written).toContain('pages/topic/power-query.md');
    expect(result.written).toContain('pages/project/excel-etl.md');

    const note = fs.readFileSync(path.join(outDir, 'pages', 'topic', 'power-query.md'), 'utf8');
    const frontmatterEnd = note.indexOf('\n---\n', 4);
    expect(note.startsWith('---\ntitle: Power Query\n')).toBe(true);
    // Key order is fixed, so two runs cannot reorder the frontmatter.
    const keys = note
      .slice(4, frontmatterEnd)
      .split('\n')
      .filter((line) => /^[a-z_]+:/.test(line))
      .map((line) => line.split(':')[0]);
    expect(keys).toEqual([
      'title',
      'page_type',
      'scope',
      'status',
      'version',
      'tags',
      'aliases',
      'sources',
    ]);
    expect(note).toContain('page_type: topic');
    // `scope` is always written, `global` included: it says which conversation
    // the page exists for, which the directory alone does not.
    expect(note).toContain('scope: global');
    expect(note).toContain('status: active');
    expect(note).toContain('version: 3');
    expect(note).toContain('  - etl');
    expect(note).toContain('  - PQ');
    expect(note).toContain('  - memory:mem-1');
    expect(note).toContain('  - message:msg-1');
    // Body verbatim (only the trailing newline is normalised).
    expect(note.slice(frontmatterEnd + 5)).toBe('\nPower Query is how the monthly ETL runs.\n');

    const index = fs.readFileSync(path.join(outDir, 'index.md'), 'utf8');
    expect(index).toContain('| Pages | 2 |');
    expect(index).toContain('## Pages');
    expect(index).toContain('- [[power-query|Power Query]] — topic');

    // Projection, not authorship: a second run over the same rows is a no-op.
    const second = exportVault({ db, outDir });
    expect(second.written).toEqual([]);
    expect(second.unchanged).toContain('pages/topic/power-query.md');
  });

  it('omits pending and archived pages, and deletes a note when its page is archived', () => {
    insertPage({ id: 'page-ok', slug: 'kept-page', title: 'Kept', content: 'Active body.' });
    insertPage({
      id: 'page-pending',
      slug: 'shadow-page',
      title: 'Shadow',
      content: 'Unreviewed curation.',
      status: 'pending',
    });
    insertPage({
      id: 'page-archived',
      slug: 'old-page',
      title: 'Old',
      content: 'History.',
      status: 'archived',
    });

    const first = exportVault({ db, outDir });

    expect(first.written.filter((file) => file.startsWith('pages/'))).toEqual([
      'pages/topic/kept-page.md',
    ]);
    expect(fs.existsSync(path.join(outDir, 'pages', 'topic', 'shadow-page.md'))).toBe(false);
    expect(fs.existsSync(path.join(outDir, 'pages', 'topic', 'old-page.md'))).toBe(false);
    const index = fs.readFileSync(path.join(outDir, 'index.md'), 'utf8');
    expect(index).toContain('| Pages | 1 |');

    // Archiving removes the note: the vault follows the status filter, and a
    // page note is a deletable generated path like any other.
    db.prepare("UPDATE knowledge_pages SET status = 'archived' WHERE id = 'page-ok'").run();
    const second = exportVault({ db, outDir });
    expect(second.deleted).toEqual(['pages/topic/kept-page.md']);
    expect(fs.existsSync(path.join(outDir, 'pages', 'topic', 'kept-page.md'))).toBe(false);
  });

  it('names the file after the slug so an Obsidian [[slug]] resolves to it', () => {
    insertPage({
      id: 'page-target',
      slug: 'power-query',
      title: 'Power Query',
      content: 'The ETL tool.',
    });
    insertPage({
      id: 'page-source',
      slug: 'excel-etl',
      title: 'Excel ETL',
      content: 'Runs on [[power-query]] every week.',
    });

    exportVault({ db, outDir });

    // Obsidian resolves a bare `[[power-query]]` by file name, so the stem has to
    // be the slug: exactly one note in the vault may carry that name.
    const matches = Object.keys(snapshot(outDir)).filter((file) =>
      file.endsWith('/power-query.md'),
    );
    expect(matches).toEqual(['pages/topic/power-query.md']);
    expect(fs.readFileSync(path.join(outDir, ...matches[0].split('/')), 'utf8')).toContain(
      'The ETL tool.',
    );
    // The linking note keeps the body verbatim, so the link is still there.
    expect(fs.readFileSync(path.join(outDir, 'pages', 'topic', 'excel-etl.md'), 'utf8')).toContain(
      '[[power-query]]',
    );
  });

  it('falls back to pages/<slug>.md when page_type is outside the closed set', () => {
    insertPage({
      id: 'page-legacy',
      pageType: 'legacy-import',
      slug: 'imported-note',
      title: 'Imported',
      content: 'From an older database.',
    });

    exportVault({ db, outDir });

    expect(fs.existsSync(path.join(outDir, 'pages', 'imported-note.md'))).toBe(true);
    const note = fs.readFileSync(path.join(outDir, 'pages', 'imported-note.md'), 'utf8');
    // The stored value is projected, not guessed into the closed set.
    expect(note).toContain('page_type: legacy-import');
  });

  describe('page scope', () => {
    const CHAT_A = 'feishu:oc_a';
    const CHAT_B = 'telegram:42';

    function noteAt(relativePath: string): string {
      return fs.readFileSync(path.join(outDir, ...relativePath.split('/')), 'utf8');
    }

    /** One slug, one page type, three conversations — the collision case. */
    function insertSameSlugEverywhere(): void {
      insertPage({
        id: 'page-global',
        slug: 'deploy-process',
        title: 'Deploy process',
        content: 'Console copy.',
        scope: 'global',
      });
      insertPage({
        id: 'page-chat-a',
        slug: 'deploy-process',
        title: 'Deploy process',
        content: 'Feishu copy.',
        scope: CHAT_A,
      });
      insertPage({
        id: 'page-chat-b',
        slug: 'deploy-process',
        title: 'Deploy process',
        content: 'Telegram copy.',
        scope: CHAT_B,
      });
    }

    it('writes one note per scope instead of overwriting one path', () => {
      insertSameSlugEverywhere();

      const result = exportVault({ db, outDir });

      // The global page keeps the pre-scope path, so an existing vault and its
      // `[[deploy-process]]` links keep working.
      const globalNote = noteAt('pages/topic/deploy-process.md');
      expect(globalNote).toContain('Console copy.');
      expect(globalNote).toContain('scope: global');

      // A scoped page gets an address of its own — scope, then page type — so the
      // second write cannot replace the first (that is what a bare
      // `pages/<page_type>/<slug>.md` did once two chats shared a slug).
      const chatA = noteAt('pages/feishu-oc-a/topic/deploy-process.md');
      expect(chatA).toContain('Feishu copy.');
      expect(chatA).toContain('scope: feishu:oc_a');
      const chatB = noteAt('pages/telegram-42/topic/deploy-process.md');
      expect(chatB).toContain('Telegram copy.');
      expect(chatB).toContain('scope: telegram:42');

      expect(result.written.filter((file) => file.startsWith('pages/')).sort()).toEqual([
        'pages/feishu-oc-a/topic/deploy-process.md',
        'pages/telegram-42/topic/deploy-process.md',
        'pages/topic/deploy-process.md',
      ]);
    });

    it('counts pages once and recognises both path shapes on a re-run', () => {
      insertSameSlugEverywhere();
      exportVault({ db, outDir });

      const index = noteAt('index.md');
      expect(index).toContain('| Pages | 3 |');
      // One entry per page, not one per file that survived a collision.
      expect(index.split('\n').filter((line) => line.includes('deploy-process'))).toHaveLength(3);
      // A global page is still linked by its bare slug (Obsidian shortest path);
      // a scoped one is linked by path, because its stem is no longer unique.
      expect(index).toContain('- [[deploy-process|Deploy process]] — topic');
      expect(index).toContain(
        '- [[pages/feishu-oc-a/topic/deploy-process|Deploy process]] — topic, feishu:oc_a',
      );

      // Both shapes are inside the generated namespace ...
      expect(isGeneratedNotePath('pages/topic/deploy-process.md')).toBe(true);
      expect(isGeneratedNotePath('pages/feishu-oc-a/topic/deploy-process.md')).toBe(true);
      expect(isGeneratedNotePath('../escape.md')).toBe(false);

      // ... so a re-run neither rewrites nor deletes them, at either depth.
      const second = exportVault({ db, outDir });
      expect(second.written).toEqual([]);
      expect(second.deleted).toEqual([]);
      expect(second.unchanged).toEqual(
        expect.arrayContaining([
          'pages/topic/deploy-process.md',
          'pages/feishu-oc-a/topic/deploy-process.md',
          'pages/telegram-42/topic/deploy-process.md',
        ]),
      );
      const state = JSON.parse(noteAt(VAULT_STATE_FILE)) as { files: string[] };
      expect(state.files).toEqual(
        expect.arrayContaining([
          'pages/topic/deploy-process.md',
          'pages/feishu-oc-a/topic/deploy-process.md',
          'pages/telegram-42/topic/deploy-process.md',
        ]),
      );
    });

    it('deletes a scoped note, and only that one, when its page is archived', () => {
      insertSameSlugEverywhere();
      exportVault({ db, outDir });

      db.prepare("UPDATE knowledge_pages SET status = 'archived' WHERE id = 'page-chat-a'").run();

      const second = exportVault({ db, outDir });

      expect(second.deleted).toEqual(['pages/feishu-oc-a/topic/deploy-process.md']);
      expect(
        fs.existsSync(path.join(outDir, 'pages', 'feishu-oc-a', 'topic', 'deploy-process.md')),
      ).toBe(false);
      // The same slug in the console and in the other chat is untouched.
      expect(noteAt('pages/topic/deploy-process.md')).toContain('Console copy.');
      expect(noteAt('pages/telegram-42/topic/deploy-process.md')).toContain('Telegram copy.');
    });

    it('keeps two scopes that slugify alike in separate directories', () => {
      // `feishu:oc-1` and `feishu:oc_1` fold onto the same directory name, so the
      // hash suffix is what stops one chat's note from replacing the other's.
      insertPage({
        id: 'page-dash',
        slug: 'deploy-process',
        title: 'Deploy process',
        content: 'Dash scope.',
        scope: 'feishu:oc-1',
      });
      insertPage({
        id: 'page-underscore',
        slug: 'deploy-process',
        title: 'Deploy process',
        content: 'Underscore scope.',
        scope: 'feishu:oc_1',
      });

      exportVault({ db, outDir });

      const notes = Object.keys(snapshot(outDir)).filter((file) => file.startsWith('pages/'));
      expect(notes).toHaveLength(2);
      expect(new Set(notes.map((file) => file.split('/')[1])).size).toBe(2);
      const contents = notes.map((file) => noteAt(file)).sort();
      expect(contents.some((text) => text.includes('Dash scope.'))).toBe(true);
      expect(contents.some((text) => text.includes('Underscore scope.'))).toBe(true);
      // Deterministic: the paths do not depend on insertion order.
      const firstPaths = Object.keys(snapshot(outDir)).sort();
      const second = exportVault({ db, outDir });
      expect(second.written).toEqual([]);
      expect(Object.keys(snapshot(outDir)).sort()).toEqual(firstPaths);
    });
  });
});

describe('parseAliases', () => {
  it('accepts JSON arrays, delimited strings and raw values', () => {
    expect(parseAliases('["Al","A. Smith"]')).toEqual(['Al', 'A. Smith']);
    expect(parseAliases('Al, A. Smith')).toEqual(['Al', 'A. Smith']);
    expect(parseAliases('Al、A. Smith')).toEqual(['Al', 'A. Smith']);
    expect(parseAliases('Al')).toEqual(['Al']);
    expect(parseAliases('')).toEqual([]);
    expect(parseAliases(null)).toEqual([]);
    expect(parseAliases('{"unexpected":true}')).toEqual([]);
  });
});
