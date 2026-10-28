/**
 * `session-access.ts` — the session/message dimension `MemoryAccessPolicy` does
 * not have.
 *
 * The invariant under test is the one that decides whether a live database is
 * searchable at all: **an unset policy field never filters.** In particular the
 * `unknown` channel must stay visible under the default policy — the single
 * `unknown` session in the live database is the seed session `shadow-seed-1007`,
 * and `inferChannel` returning `unknown` for it is correct, not a defect.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/memory/db';
import { resolveSessionChannel, sessionVisible } from '../../src/memory/session-access';
import type { SessionRow } from '../../src/memory/session-access';

let db: Database.Database;

beforeEach(() => {
  db = openDatabase(':memory:');
});

afterEach(() => {
  db.close();
});

/** Insert a session and read back exactly the columns the policy reads. */
function seedSession(input: {
  id: string;
  chatId?: string | null;
  projectId?: string | null;
  channel?: string | null;
}): SessionRow {
  db.prepare(
    `INSERT INTO sessions (id, chat_id, user_id, project_id, channel, external_chat_id, title, metadata, created_at, updated_at)
     VALUES (?, ?, 'user-1', ?, ?, NULL, NULL, NULL, ?, ?)`,
  ).run(
    input.id,
    input.chatId ?? input.id,
    input.projectId ?? null,
    input.channel ?? null,
    '1700000000000',
    '1700000000000',
  );

  return db
    .prepare('SELECT id, chat_id, project_id, channel FROM sessions WHERE id = ?')
    .get(input.id) as SessionRow;
}

describe('sessionVisible: defaults do not filter', () => {
  it('keeps the unknown-channel seed session visible under an empty policy', () => {
    const seed = seedSession({ id: 'shadow-seed-1007', channel: 'unknown' });

    expect(resolveSessionChannel(seed)).toBe('unknown');
    expect(sessionVisible(seed, {})).toBe(true);
    // An omitted policy argument behaves exactly like an empty one.
    expect(sessionVisible(seed)).toBe(true);
  });

  it('treats `channels: undefined` as every channel, and an empty list as none', () => {
    const feishu = seedSession({ id: 'oc_abc123', channel: 'feishu' });
    const unknown = seedSession({ id: 'shadow-seed-1007', channel: 'unknown' });

    expect(sessionVisible(unknown, { channels: undefined })).toBe(true);
    expect(sessionVisible(feishu, { channels: undefined })).toBe(true);
    expect(sessionVisible(feishu, { channels: ['feishu'] })).toBe(true);
    // Explicit list → everything else, `unknown` included, is filtered out.
    expect(sessionVisible(unknown, { channels: ['feishu'] })).toBe(false);
    // Explicit empty list means empty, not "everything".
    expect(sessionVisible(feishu, { channels: [] })).toBe(false);
  });

  it('does not filter on the inbox by default', () => {
    const im = seedSession({ id: 'telegram:42', channel: 'telegram' });

    expect(im.project_id).toBeNull();
    expect(sessionVisible(im, {})).toBe(true);
    expect(sessionVisible(im, { includeInbox: true })).toBe(true);
  });
});

describe('resolveSessionChannel', () => {
  it('falls back to inferChannel when the channel column is NULL', () => {
    const webui = seedSession({ id: '7f3c-uuid', chatId: 'webui:proj-1', channel: null });
    const telegram = seedSession({ id: 'telegram:99', channel: null });
    const cron = seedSession({ id: 'cron:nightly', channel: null });

    expect(resolveSessionChannel(webui)).toBe('webui');
    expect(resolveSessionChannel(telegram)).toBe('telegram');
    expect(resolveSessionChannel(cron)).toBe('cron');
  });

  it('prefers the recorded channel over the id shape', () => {
    // A session whose id looks like a Feishu chat but was recorded as wechat:
    // the column wins, the id is only a fallback.
    const session = seedSession({ id: 'oc_abc123', channel: 'wechat' });
    expect(resolveSessionChannel(session)).toBe('wechat');
  });
});

describe('sessionVisible: project and inbox narrowing', () => {
  it('narrows to one project and leaves other projects out', () => {
    const alpha = seedSession({ id: 's-alpha', projectId: 'proj-a', channel: 'webui' });
    const beta = seedSession({ id: 's-beta', projectId: 'proj-b', channel: 'webui' });

    expect(sessionVisible(alpha, { projectId: 'proj-a' })).toBe(true);
    expect(sessionVisible(beta, { projectId: 'proj-a' })).toBe(false);
  });

  it('reads `projectId: null` as "the IM inbox only"', () => {
    const project = seedSession({ id: 's-alpha', projectId: 'proj-a', channel: 'webui' });
    const im = seedSession({ id: 'oc_abc123', channel: 'feishu' });

    expect(sessionVisible(im, { projectId: null })).toBe(true);
    expect(sessionVisible(project, { projectId: null })).toBe(false);
  });

  it('hides project-less sessions when the inbox is excluded', () => {
    const project = seedSession({ id: 's-alpha', projectId: 'proj-a', channel: 'webui' });
    const im = seedSession({ id: 'oc_abc123', channel: 'feishu' });

    expect(sessionVisible(im, { includeInbox: false })).toBe(false);
    expect(sessionVisible(project, { includeInbox: false })).toBe(true);
  });

  it('combines the dimensions as an AND', () => {
    const project = seedSession({ id: 's-alpha', projectId: 'proj-a', channel: 'webui' });

    expect(sessionVisible(project, { projectId: 'proj-a', channels: ['webui'] })).toBe(true);
    expect(sessionVisible(project, { projectId: 'proj-a', channels: ['feishu'] })).toBe(false);
    expect(sessionVisible(project, { projectId: 'proj-b', channels: ['webui'] })).toBe(false);
  });
});
