/**
 * Auto-archive maintenance job (session-auto-archive-job.ts).
 *
 * The contract the settings switch depends on:
 *   - disabled (`enabled: false`, or no `archive:` section at all) writes nothing
 *     and reports `skipped`, so the operator sees the job alive but idle;
 *   - eligibility is "last activity older than N days", not "created N days ago";
 *   - a conversation with a turn in flight is never archived;
 *   - a run touches at most one batch, and says so.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/memory/db';
import {
  createSessionAutoArchiveJob,
  type ArchiveAutoConfig,
} from '../../src/memory/maintenance/jobs/session-auto-archive-job';

const DAY = 86_400_000;

describe('session auto-archive job', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
    db.prepare(
      "INSERT INTO projects (id, name, agent_id) VALUES ('proj-1', 'OMA', 'default')",
    ).run();
  });

  afterEach(() => {
    db.close();
  });

  function seedSession(id: string, ageDays: number, projectId: string | null = 'proj-1'): void {
    const when = String(Date.now() - ageDays * DAY);
    db.prepare(
      `INSERT INTO sessions
         (id, chat_id, user_id, project_id, channel, external_chat_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(
      id,
      id,
      projectId ? 'webui-user' : 'unknown',
      projectId,
      projectId ? null : 'feishu',
      id,
      when,
      when,
    );
  }

  function archivedIds(): string[] {
    return (
      db
        .prepare('SELECT id FROM sessions WHERE archived_at IS NOT NULL ORDER BY id')
        .all() as Array<{
        id: string;
      }>
    ).map((row) => row.id);
  }

  it('writes nothing and reports skipped while disabled', async () => {
    seedSession('old', 40);
    const job = createSessionAutoArchiveJob(db, () => ({ enabled: false, days: 30 }));

    const result = await job.run({ dryRun: false });
    expect(result.status).toBe('skipped');
    expect(result.affectedRows).toBe(0);
    expect(archivedIds()).toEqual([]);
  });

  it('treats a missing archive section as disabled', async () => {
    seedSession('old', 40);
    const job = createSessionAutoArchiveJob(db, () => undefined);

    const result = await job.run({ dryRun: false });
    expect(result.status).toBe('skipped');
    expect(archivedIds()).toEqual([]);
  });

  it('archives by last activity across both trees', async () => {
    seedSession('project-old', 45, 'proj-1');
    seedSession('inbox-old', 60, null);
    seedSession('project-fresh', 2, 'proj-1');
    const job = createSessionAutoArchiveJob(db, () => ({ enabled: true, days: 30 }));

    const result = await job.run({ dryRun: false });
    expect(result.status).toBe('success');
    expect(result.affectedRows).toBe(2);
    expect(archivedIds()).toEqual(['inbox-old', 'project-old']);
  });

  it('does not use creation time — a long-lived active chat stays active', async () => {
    // Created 400 days ago, active now: the old-by-creation conversation must not
    // be archived, which is the whole point of measuring last activity.
    db.prepare(
      `INSERT INTO sessions (id, chat_id, user_id, project_id, channel, created_at, updated_at)
       VALUES ('veteran', 'veteran', 'webui-user', 'proj-1', NULL, ?, ?)`,
    ).run(String(Date.now() - 400 * DAY), String(Date.now()));
    const job = createSessionAutoArchiveJob(db, () => ({ enabled: true, days: 30 }));

    expect((await job.run({ dryRun: false })).affectedRows).toBe(0);
    expect(archivedIds()).toEqual([]);
  });

  it('drains the whole queue in one run instead of stopping at one batch', async () => {
    // More than one UPDATE batch worth: a single-click sweep must not stop at 500.
    for (let i = 0; i < 620; i += 1) seedSession(`old-${i}`, 40);
    const job = createSessionAutoArchiveJob(db, () => ({ enabled: true, days: 30 }));

    const result = await job.run({ dryRun: false });
    expect(result.affectedRows).toBe(620);
    expect((result.details as { batches: number }).batches).toBe(2);
    expect((result.details as { remaining: number }).remaining).toBe(0);
    expect((result.details as { truncated: boolean }).truncated).toBe(false);
  });

  it('skips a conversation with a turn in flight', async () => {
    seedSession('busy', 90);
    seedSession('idle', 90);
    const job = createSessionAutoArchiveJob(
      db,
      () => ({ enabled: true, days: 30 }),
      (id) => id === 'busy',
    );

    const result = await job.run({ dryRun: false });
    expect(result.affectedRows).toBe(1);
    expect(archivedIds()).toEqual(['idle']);
    expect(result.details).toMatchObject({ skippedRunning: 1, remaining: 1 });
  });

  it('reports the count without writing on a dry run', async () => {
    seedSession('old', 40);
    const job = createSessionAutoArchiveJob(db, () => ({ enabled: true, days: 30 }));

    const result = await job.run({ dryRun: true });
    expect(result.affectedRows).toBe(1);
    expect(result.dryRun).toBe(true);
    expect(archivedIds()).toEqual([]);
  });

  it('never re-archives a conversation that is already archived', async () => {
    seedSession('manual', 40);
    db.prepare('UPDATE sessions SET archived_at = ? WHERE id = ?').run('1000', 'manual');
    const job = createSessionAutoArchiveJob(db, () => ({ enabled: true, days: 30 }));

    expect((await job.run({ dryRun: false })).affectedRows).toBe(0);
    // The earlier manual archive time is preserved: archiving is not re-stamped.
    expect(db.prepare('SELECT archived_at FROM sessions WHERE id = ?').get('manual')).toEqual({
      archived_at: '1000',
    });
  });

  it('reads its threshold live, so a config edit applies without a restart', async () => {
    seedSession('ten-days', 10);
    let config: ArchiveAutoConfig = { enabled: true, days: 30 };
    const job = createSessionAutoArchiveJob(db, () => config);

    expect((await job.run({ dryRun: false })).affectedRows).toBe(0);
    config = { enabled: true, days: 7 };
    expect((await job.run({ dryRun: false })).affectedRows).toBe(1);
    expect(archivedIds()).toEqual(['ten-days']);
  });
});
