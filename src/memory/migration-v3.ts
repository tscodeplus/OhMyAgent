import type Database from 'better-sqlite3';

export interface V3MigrationResult {
  added: string[];
  skipped: string[];
}

export function runV3Migrations(db: Database.Database): V3MigrationResult {
  const added: string[] = [];
  const skipped: string[] = [];

  const cols = db.pragma('table_info(memories)') as Array<{ name: string }>;
  const colNames = new Set(cols.map(c => c.name));

  // Lifecycle fields
  const lifecycleFields = [
    { name: 'status', ddl: "ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active'" },
    { name: 'supersedes_id', ddl: 'ALTER TABLE memories ADD COLUMN supersedes_id TEXT' },
    { name: 'source_channel', ddl: 'ALTER TABLE memories ADD COLUMN source_channel TEXT' },
    { name: 'source_message_id', ddl: 'ALTER TABLE memories ADD COLUMN source_message_id TEXT' },
    { name: 'confidence', ddl: 'ALTER TABLE memories ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0' },
    { name: 'invalidated_at', ddl: 'ALTER TABLE memories ADD COLUMN invalidated_at TEXT' },
  ];

  for (const field of lifecycleFields) {
    if (!colNames.has(field.name)) {
      db.exec(field.ddl);
      added.push(field.name);
    } else {
      skipped.push(field.name);
    }
  }

  // Indexes
  const indexStatements = [
    'CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status)',
    'CREATE INDEX IF NOT EXISTS idx_memories_supersedes ON memories(supersedes_id)',
    'CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source_channel, source_message_id)',
  ];
  for (const idx of indexStatements) {
    db.exec(idx);
  }

  // Persona distillation runs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS persona_distillation_runs (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      active_preference_count INTEGER NOT NULL,
      started_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
      finished_at TEXT,
      error TEXT
    )
  `);

  // Maintenance runs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS maintenance_runs (
      id TEXT PRIMARY KEY,
      job_name TEXT NOT NULL,
      status TEXT NOT NULL,
      dry_run INTEGER NOT NULL DEFAULT 0,
      affected_rows INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
      finished_at TEXT,
      error TEXT
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_maintenance_runs_job ON maintenance_runs(job_name, started_at)');

  return { added, skipped };
}
