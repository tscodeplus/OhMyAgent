import type Database from 'better-sqlite3';

const DDL_SESSIONS = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  thread_id TEXT,
  user_id TEXT NOT NULL,
  project_id TEXT,
  created_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
  updated_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
  metadata TEXT
)`;

const DDL_MESSAGES = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_call_id TEXT,
  created_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
  metadata TEXT
)`;

const DDL_PROCESSED_MESSAGES = `
CREATE TABLE IF NOT EXISTS processed_messages (
  source TEXT NOT NULL,
  message_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  session_key TEXT,
  processed_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
  metadata TEXT,
  PRIMARY KEY (source, message_id)
)`;

const DDL_EPISODES = `
CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  summary TEXT NOT NULL,
  key_points TEXT,
  created_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000)
)`;

const DDL_MEMORIES = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT,
  agent_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'shared',
  status TEXT NOT NULL DEFAULT 'active',
  supersedes_id TEXT,
  source_channel TEXT,
  source_message_id TEXT,
  confidence REAL NOT NULL DEFAULT 1.0,
  invalidated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
  updated_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000)
)`;

const DDL_MEMORY_EMBEDDINGS = `
CREATE TABLE IF NOT EXISTS memory_embeddings (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000)
)`;

const DDL_EMBEDDING_CACHE = `
CREATE TABLE IF NOT EXISTS embedding_cache (
  content_hash TEXT PRIMARY KEY,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000)
)`;

const DDL_MEMORIES_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  content=memories,
  content_rowid=rowid,
  tokenize='unicode61 remove_diacritics 2'
)`;

const TRIGGER_MEMORIES_FTS_AI = `
CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END`;

const TRIGGER_MEMORIES_FTS_AD = `
CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END`;

const TRIGGER_MEMORIES_FTS_AU = `
CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END`;

const DDL_TOOL_RUNS = `
CREATE TABLE IF NOT EXISTS tool_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  tool_name TEXT NOT NULL,
  input TEXT,
  output TEXT,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
  metadata TEXT
)`;

const DDL_APPROVAL_POLICIES = `
CREATE TABLE IF NOT EXISTS approval_policies (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  pattern_type TEXT NOT NULL,
  pattern TEXT NOT NULL,
  effect TEXT NOT NULL,
  created_by TEXT,
  source TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
  updated_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000)
)`;

const DDL_APPROVAL_REQUESTS = `
CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  chat_id TEXT,
  thread_id TEXT,
  requester_id TEXT,
  target_kind TEXT NOT NULL,
  tool_name TEXT,
  command_text TEXT,
  normalized_command TEXT,
  risk_level TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  decision_mode TEXT,
  policy_scope TEXT,
  card_message_id TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
  updated_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000)
)`;

const DDL_APPROVAL_DECISIONS = `
CREATE TABLE IF NOT EXISTS approval_decisions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES approval_requests(id),
  decided_by TEXT NOT NULL,
  decision TEXT NOT NULL,
  decision_scope TEXT,
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000)
)`;

const DDL_MEMORY_LINKS = `
CREATE TABLE IF NOT EXISTS memory_links (
  id TEXT PRIMARY KEY,
  source_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_entity TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000)
)`;

const DDL_PERSONA_DISTILLATION_RUNS = `
CREATE TABLE IF NOT EXISTS persona_distillation_runs (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  active_preference_count INTEGER NOT NULL,
  started_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
  finished_at TEXT,
  error TEXT
)`;

const DDL_MAINTENANCE_RUNS = `
CREATE TABLE IF NOT EXISTS maintenance_runs (
  id TEXT PRIMARY KEY,
  job_name TEXT NOT NULL,
  status TEXT NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 0,
  affected_rows INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
  finished_at TEXT,
  error TEXT
)`;

const DDL_MEMORY_OBSERVATION_EVENTS = `
CREATE TABLE IF NOT EXISTS memory_observation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000)
)`;

const DDL_MEMORY_TERMS = `
CREATE TABLE IF NOT EXISTS memory_terms (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  term TEXT NOT NULL,
  term_type TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
  PRIMARY KEY (memory_id, term, term_type)
)`;

const DDL_SCHEMA_VERSION = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000)
)`;

const DDL_PROJECTS = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
  updated_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000)
)`;

// P1-4: Skill feedback tracking
const DDL_SKILL_FEEDBACK = `
CREATE TABLE IF NOT EXISTS skill_feedback (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  session_id TEXT,
  task_message TEXT NOT NULL,
  tool_calls_json TEXT,
  success INTEGER,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000)
)`;

// Indexes
const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_skill_feedback_skill ON skill_feedback(skill_id)',
  'CREATE INDEX IF NOT EXISTS idx_skill_feedback_session ON skill_feedback(session_id)',
  'CREATE INDEX IF NOT EXISTS idx_skill_feedback_created ON skill_feedback(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)',
  'CREATE INDEX IF NOT EXISTS idx_processed_messages_processed_at ON processed_messages(processed_at)',
  'CREATE INDEX IF NOT EXISTS idx_processed_messages_source_session ON processed_messages(source, session_key)',
  'CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id)',
  'CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, scope_key)',
  'CREATE INDEX IF NOT EXISTS idx_tool_runs_session ON tool_runs(session_id)',
  'CREATE INDEX IF NOT EXISTS idx_approval_policies_scope ON approval_policies(scope, scope_key)',
  'CREATE INDEX IF NOT EXISTS idx_approval_requests_session ON approval_requests(session_key)',
  'CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status)',
  'CREATE INDEX IF NOT EXISTS idx_memory_links_entity ON memory_links(target_entity, relation_type)',
  'CREATE INDEX IF NOT EXISTS idx_memory_links_source ON memory_links(source_memory_id)',
  'CREATE INDEX IF NOT EXISTS idx_maintenance_runs_job ON maintenance_runs(job_name, started_at)',
  'CREATE INDEX IF NOT EXISTS idx_memory_observation_events_event ON memory_observation_events(event, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_memory_terms_term ON memory_terms(term, term_type)',
  'CREATE INDEX IF NOT EXISTS idx_memory_terms_memory ON memory_terms(memory_id)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)',
  // memory_embeddings.memory_id is a FK but SQLite does NOT auto-index FKs.
  // findByMemoryId / deleteByMemoryId / cosineSearch's JOIN all filter on it.
  'CREATE INDEX IF NOT EXISTS idx_memory_embeddings_memory ON memory_embeddings(memory_id)',
  // Hygiene scans `kind IN (...) AND updated_at < ? ORDER BY updated_at`.
  'CREATE INDEX IF NOT EXISTS idx_memories_kind_updated ON memories(kind, updated_at)',
  // Candidate selection filters the active pool by agent_id / visibility.
  'CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id)',
  'CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status)',
];

// sqlite-vec virtual table (commented out by default, needs extension loaded)
// CREATE VIRTUAL TABLE vec_memory_embeddings USING vec0(
//   memory_id TEXT PRIMARY KEY,
//   embedding float[{dimension}]
// );

const ALL_DDL = [
  DDL_SESSIONS,
  DDL_MESSAGES,
  DDL_PROCESSED_MESSAGES,
  DDL_EPISODES,
  DDL_MEMORIES,
  DDL_MEMORY_EMBEDDINGS,
  DDL_EMBEDDING_CACHE,
  DDL_TOOL_RUNS,
  DDL_APPROVAL_POLICIES,
  DDL_APPROVAL_REQUESTS,
  DDL_APPROVAL_DECISIONS,
  DDL_MEMORY_LINKS,
  DDL_MEMORY_TERMS,
  DDL_PERSONA_DISTILLATION_RUNS,
  DDL_MAINTENANCE_RUNS,
  DDL_MEMORY_OBSERVATION_EVENTS,
  DDL_SCHEMA_VERSION,
  DDL_PROJECTS,
  DDL_MEMORIES_FTS,
  DDL_SKILL_FEEDBACK,
];

const ALL_TRIGGERS = [
  TRIGGER_MEMORIES_FTS_AI,
  TRIGGER_MEMORIES_FTS_AD,
  TRIGGER_MEMORIES_FTS_AU,
];

/**
 * Apply all DDL statements (tables + indexes) to the database.
 */
export function applySchema(db: Database.Database): void {
  const runInTransaction = db.transaction(() => {
    for (const ddl of ALL_DDL) {
      db.exec(ddl);
    }
    migrateProcessedMessagesSchema(db);
    for (const idx of INDEXES) {
      db.exec(idx);
    }
    for (const trig of ALL_TRIGGERS) {
      db.exec(trig);
    }
  });
  runInTransaction();
}

function migrateProcessedMessagesSchema(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(processed_messages)').all() as Array<{
    name: string;
    pk: number;
  }>;

  if (columns.length === 0) {
    return;
  }

  const hasSource = columns.some(column => column.name === 'source');
  const hasCompositePrimaryKey = columns.filter(column => column.pk > 0).length >= 2;
  if (hasSource && hasCompositePrimaryKey) {
    return;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_messages_v2 (
      source TEXT NOT NULL,
      message_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      session_key TEXT,
      processed_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
      metadata TEXT,
      PRIMARY KEY (source, message_id)
    )
  `);

  db.exec(`
    INSERT OR IGNORE INTO processed_messages_v2 (source, message_id, event_type, session_key, processed_at, metadata)
    SELECT 'feishu', message_id, event_type, session_key, processed_at, metadata
    FROM processed_messages
  `);

  db.exec('DROP TABLE processed_messages');
  db.exec('ALTER TABLE processed_messages_v2 RENAME TO processed_messages');
}
