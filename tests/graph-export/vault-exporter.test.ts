import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema';
import {
  ENTITY_TABLES_ABSENT_NOTICE,
  VAULT_STATE_FILE,
  exportVault,
} from '../../src/graph-export/vault-exporter';
import { parseAliases } from '../../src/graph-export/entity-tables';
import {
  VaultPathError,
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
