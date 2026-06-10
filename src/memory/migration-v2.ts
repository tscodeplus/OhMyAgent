import type Database from 'better-sqlite3';

export interface V2MigrationResult {
  added: string[];
  skipped: string[];
}

export function runV2Migrations(db: Database.Database): V2MigrationResult {
  const added: string[] = [];
  const skipped: string[] = [];

  const cols = db.pragma('table_info(memories)') as Array<{ name: string }>;
  const colNames = new Set(cols.map(c => c.name));

  if (!colNames.has('agent_id')) {
    db.exec('ALTER TABLE memories ADD COLUMN agent_id TEXT DEFAULT NULL');
    added.push('agent_id');
  } else {
    skipped.push('agent_id');
  }

  if (!colNames.has('visibility')) {
    db.exec("ALTER TABLE memories ADD COLUMN visibility TEXT DEFAULT 'shared'");
    added.push('visibility');
  } else {
    skipped.push('visibility');
  }

  return { added, skipped };
}
