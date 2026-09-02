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

  // Runs BEFORE applySchema (see openDatabase) so a pre-v2 database has these
  // columns by the time applySchema creates idx_memories_agent /
  // idx_memories_status. A brand-new database has no `memories` table yet, and
  // DDL_MEMORIES already declares both columns — nothing to alter.
  if (colNames.size === 0) {
    return { added, skipped };
  }

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
