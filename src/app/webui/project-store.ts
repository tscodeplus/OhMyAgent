/**
 * Project Store — SQLite CRUD for projects table.
 */

import type Database from 'better-sqlite3';
import { generateId } from '../../shared/ids.js';

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  agent_id: string;
  created_at: string;
  updated_at: string;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  agent_id: string;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  agent_id?: string;
}

export class ProjectStore {
  private db: Database.Database;
  private stmt_insert: Database.Statement;
  private stmt_getById: Database.Statement;
  private stmt_list: Database.Statement;
  private stmt_update: Database.Statement;
  private stmt_delete: Database.Statement;
  private stmt_countSessions: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    // Ensure table exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
        updated_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000)
      )
    `);

    this.stmt_insert = db.prepare(`
      INSERT INTO projects (id, name, description, agent_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, cast(strftime('%s','now') as integer) * 1000, cast(strftime('%s','now') as integer) * 1000)
    `);

    this.stmt_getById = db.prepare('SELECT * FROM projects WHERE id = ?');
    this.stmt_list = db.prepare('SELECT * FROM projects ORDER BY name ASC');
    this.stmt_update = db.prepare(`
      UPDATE projects SET name = COALESCE(?, name), description = COALESCE(?, description),
        agent_id = COALESCE(?, agent_id), updated_at = cast(strftime('%s','now') as integer) * 1000
      WHERE id = ?
    `);
    this.stmt_delete = db.prepare('DELETE FROM projects WHERE id = ?');
    this.stmt_countSessions = db.prepare('SELECT COUNT(*) as count FROM sessions WHERE project_id = ?');
  }

  create(input: CreateProjectInput): ProjectRow {
    const id = generateId();
    this.stmt_insert.run(id, input.name, input.description || null, input.agent_id);
    return this.stmt_getById.get(id) as ProjectRow;
  }

  getById(id: string): ProjectRow | undefined {
    return this.stmt_getById.get(id) as ProjectRow | undefined;
  }

  list(): ProjectRow[] {
    return this.stmt_list.all() as ProjectRow[];
  }

  update(id: string, input: UpdateProjectInput): ProjectRow | undefined {
    this.stmt_update.run(
      input.name ?? null,
      input.description ?? null,
      input.agent_id ?? null,
      id,
    );
    return this.getById(id);
  }

  delete(id: string): boolean {
    const result = this.stmt_delete.run(id);
    return result.changes > 0;
  }

  getSessionCount(projectId: string): number {
    const row = this.stmt_countSessions.get(projectId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /**
   * Cascade delete: remove sessions and memories, then the project.
   */
  cascadeDelete(id: string): { deletedSessions: number; deletedMemories: number } {
    // 1. Find all session IDs for this project
    const sessions = this.db
      .prepare('SELECT id FROM sessions WHERE project_id = ?')
      .all(id) as { id: string }[];

    let deletedMemories = 0;
    for (const session of sessions) {
      // Delete session-level memories
      const memResult = this.db
        .prepare("DELETE FROM memories WHERE scope = 'session' AND scope_key = ?")
        .run(session.id);
      deletedMemories += memResult.changes;
      // Delete messages
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(session.id);
    }

    // 2. Delete project-level memories
    const projMemResult = this.db
      .prepare("DELETE FROM memories WHERE scope = 'project' AND scope_key = ?")
      .run(id);
    deletedMemories += projMemResult.changes;

    // 3. Delete sessions
    const sessionResult = this.db.prepare('DELETE FROM sessions WHERE project_id = ?').run(id);

    // 4. Delete project
    this.stmt_delete.run(id);

    return {
      deletedSessions: sessionResult.changes,
      deletedMemories,
    };
  }
}
