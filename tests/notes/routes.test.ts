/**
 * The notes HTTP boundary.
 *
 * What these tests pin down is the mapping, not the storage (the repository tests
 * cover that): a stale `expectedVersion` must be a 409 carrying the current body
 * so the editor can re-merge instead of discarding the user's text, a capture that
 * produced nothing usable must be 422 rather than an empty 200, and a manual note
 * must be created `active` because the human writing it *is* the review.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { registerNotesRoutes } from '../../src/app/webui/notes-routes.js';
import { createTestService, openSeededDatabase, SESSION_ID } from './fixtures.js';
import type { NotesService } from '../../src/notes/service-contract.js';
import type { NotesRepository } from '../../src/notes/repository.js';

describe('notes routes', () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let service: NotesService;
  let repository: NotesRepository;

  beforeEach(async () => {
    db = openSeededDatabase();
    const created = createTestService(db);
    service = created.service;
    repository = created.repository;
    app = Fastify({ logger: false });
    registerNotesRoutes(app, { service });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('lists active notes by default and separates drafts', async () => {
    service.createManual({ title: 'a', body: 'b' });
    repository.create({
      kind: 'other',
      title: 'draft one',
      summary: '',
      body: 'b',
      status: 'draft',
      origin: 'agent',
      scope: 'user',
      scopeKey: '',
    });

    const active = await app.inject({ method: 'GET', url: '/api/notes' });
    expect(active.statusCode).toBe(200);
    expect(active.json().notes).toHaveLength(1);
    expect(active.json().counts).toEqual({ active: 1, draft: 1, archived: 0 });

    const drafts = await app.inject({ method: 'GET', url: '/api/notes?status=draft' });
    expect(drafts.json().notes[0].title).toBe('draft one');
  });

  it('rejects an unknown status instead of silently listing active', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/notes?status=whatever' });
    expect(response.statusCode).toBe(400);
    expect(response.json().allowed).toEqual(['draft', 'active', 'archived']);
  });

  /**
   * A facet filter arrives as a set. Both spellings are accepted because
   * `URLSearchParams` writes `tag=a,b` while a hand-written link usually repeats the
   * key, and a filter that works in one and silently matches nothing in the other is
   * the kind of difference nobody debugs twice.
   */
  it('reads a facet filter from comma params and from repeated params alike', async () => {
    service.createManual({ title: 'a', body: 'b', tags: ['vitest'] });
    service.createManual({ title: 'b', body: 'b', tags: ['testing'] });
    service.createManual({ title: 'c', body: 'b', tags: ['unrelated'] });

    const comma = await app.inject({ method: 'GET', url: '/api/notes?tag=vitest,testing' });
    const repeated = await app.inject({
      method: 'GET',
      url: '/api/notes?tag=vitest&tag=testing',
    });
    const titles = (response: { json: () => { notes: Array<{ title: string }> } }) =>
      response
        .json()
        .notes.map((note) => note.title)
        .sort();

    expect(titles(comma)).toEqual(['a', 'b']);
    expect(titles(repeated)).toEqual(['a', 'b']);
  });

  it('names the offending value when a facet filter is invalid', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/notes?origin=user,bogus' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid origin', value: 'bogus' });
  });

  it('ships the facet lists with the rows', async () => {
    repository.create({
      kind: 'other',
      title: 'a',
      summary: '',
      body: 'b',
      status: 'active',
      origin: 'agent',
      scope: 'user',
      scopeKey: '',
      channel: 'feishu',
      tags: ['vitest'],
    });
    const response = await app.inject({ method: 'GET', url: '/api/notes?tag=nothing-matches' });

    // The rows are empty, but the filter row still knows what it could offer.
    expect(response.json().notes).toHaveLength(0);
    expect(response.json().tags).toEqual([{ tag: 'vitest', count: 1 }]);
    expect(response.json().channels).toEqual([{ channel: 'feishu', count: 1 }]);
    expect(response.json().projects).toEqual([]);
  });

  it('creates a manual note as active', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/notes',
      payload: { title: 'pnpm 换源', body: 'TERMUX 里用镜像源', tags: ['termux'] },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().note.status).toBe('active');
    expect(response.json().note.origin).toBe('user');
  });

  it('answers 422 for a duplicate subject and names the existing note', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/notes',
      payload: { title: 'pnpm 换源', body: 'a' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/notes',
      payload: { title: 'PNPM 换源！', body: 'b' },
    });
    expect(second.statusCode).toBe(422);
    expect(second.json().existingId).toBe(first.json().note.id);
  });

  it('answers 409 with the current body when the version is stale', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/notes',
      payload: { title: 't', body: 'original' },
    });
    const id = created.json().note.id as string;

    const stale = await app.inject({
      method: 'PUT',
      url: `/api/notes/${id}`,
      payload: { body: 'mine', expectedVersion: 42 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().currentBody).toBe('original');
    expect(stale.json().currentVersion).toBe(1);
  });

  it('answers 409 when a content edit omits the version', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/notes',
      payload: { title: 't', body: 'original' },
    });
    const response = await app.inject({
      method: 'PUT',
      url: `/api/notes/${created.json().note.id}`,
      payload: { body: 'mine' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('version_required');
  });

  it('approves a draft through the review endpoint', async () => {
    const capture = await app.inject({
      method: 'POST',
      url: '/api/notes/capture',
      payload: { sessionId: SESSION_ID, mode: 'turn' },
    });
    expect(capture.statusCode).toBe(200);
    const draftId = capture.json().notes[0].id as string;

    const approved = await app.inject({
      method: 'POST',
      url: `/api/notes/${draftId}/review`,
      payload: { decision: 'approve' },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().note.status).toBe('active');
  });

  it('rejects an unknown rejection code', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/notes',
      payload: { title: 't', body: 'b' },
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/notes/${created.json().note.id}/review`,
      payload: { decision: 'reject', reason: 'because' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('maps capture outcomes to status codes', async () => {
    const noSession = await app.inject({
      method: 'POST',
      url: '/api/notes/capture',
      payload: { sessionId: 'missing', mode: 'turn' },
    });
    expect(noSession.statusCode).toBe(404);

    const badMode = await app.inject({
      method: 'POST',
      url: '/api/notes/capture',
      payload: { sessionId: SESSION_ID, mode: 'everything' },
    });
    expect(badMode.statusCode).toBe(400);
  });

  it('archives on DELETE instead of removing the row', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/notes',
      payload: { title: 't', body: 'keep me' },
    });
    const id = created.json().note.id as string;

    const deleted = await app.inject({ method: 'DELETE', url: `/api/notes/${id}` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().note.status).toBe('archived');
    // Still there, still readable: archiving is not deleting (plan §6).
    expect(service.get(id)?.body).toBe('keep me');
  });

  it('records a view only when asked to', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/notes',
      payload: { title: 't', body: 'b' },
    });
    const id = created.json().note.id as string;

    await app.inject({ method: 'GET', url: `/api/notes/${id}` });
    expect(service.get(id)?.viewCount).toBe(0);

    await app.inject({ method: 'POST', url: `/api/notes/${id}/view` });
    expect(service.get(id)?.viewCount).toBe(1);
  });

  it('keeps dropped text verbatim through the capture route', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/notes/capture',
      payload: {
        sessionId: SESSION_ID,
        mode: 'text',
        treatment: 'verbatim',
        text: '记住：先跑单文件。',
      },
    });
    expect(response.statusCode).toBe(200);
    const note = response.json().notes[0];
    expect(note.body).toBe('记住：先跑单文件。');
    // Raw material: the user supplied the words, nobody approved them as a note.
    expect(note.status).toBe('draft');
    expect(note.origin).toBe('user');
  });

  it('rejects verbatim over a stored window, and unknown treatments', async () => {
    const overWindow = await app.inject({
      method: 'POST',
      url: '/api/notes/capture',
      payload: { sessionId: SESSION_ID, mode: 'turn', treatment: 'verbatim' },
    });
    // Copying the transcript is the failure the layer exists to prevent.
    expect(overWindow.statusCode).toBe(400);

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/notes/capture',
      payload: { sessionId: SESSION_ID, mode: 'text', treatment: 'rewrite', text: 'x' },
    });
    expect(unknown.statusCode).toBe(400);
  });

  it('accepts an instruction and refuses an over-long one', async () => {
    const ok = await app.inject({
      method: 'POST',
      url: '/api/notes/capture',
      payload: { sessionId: SESSION_ID, mode: 'recent', instruction: '只要那条命令' },
    });
    expect([200, 422]).toContain(ok.statusCode);

    const tooLong = await app.inject({
      method: 'POST',
      url: '/api/notes/capture',
      payload: { sessionId: SESSION_ID, mode: 'recent', instruction: 'x'.repeat(501) },
    });
    expect(tooLong.statusCode).toBe(400);
  });

  it('no longer serves the removed sentence-dialog prefill', async () => {
    const response = await app.inject({ url: '/api/notes/prefill?sessionId=' + SESSION_ID });
    expect(response.statusCode).toBe(404);
  });
});
