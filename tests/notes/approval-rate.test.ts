/**
 * `approvalRate` is a review verdict, not a share of the library.
 *
 * The number it used to be — `active / (active + archived)` — counted an expired
 * draft and a note the user archived themselves as rejections, so a library where
 * nobody ever reviewed anything still reported a "rate". These tests pin the
 * metric to the decisions `review()` actually recorded, and to the definition the
 * WebUI's percentage now carries.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestService, openSeededDatabase } from './fixtures.js';
import type { NotesRepository } from '../../src/notes/repository.js';
import type { NotesService } from '../../src/notes/service-contract.js';

const DAY_MS = 24 * 3600_000;

/** An agent draft: the only kind of note that has to pass the review gate. */
function draft(repository: NotesRepository, title: string, now?: number): string {
  const created = repository.create({
    title,
    summary: '',
    body: `body of ${title}`,
    status: 'draft',
    origin: 'agent',
    scope: 'user',
    scopeKey: '',
    now,
  });
  if (!created.ok) throw new Error(`create failed for ${title}`);
  return created.note.id;
}

describe('notes approvalRate', () => {
  let db: Database.Database;
  let service: NotesService;
  let repository: NotesRepository;

  beforeEach(() => {
    db = openSeededDatabase();
    const composed = createTestService(db);
    service = composed.service;
    repository = composed.repository;
  });

  afterEach(() => {
    db.close();
  });

  it('is approved / (approved + rejected) — 2 of 3 is 0.67', () => {
    const approved = [draft(repository, 'first'), draft(repository, 'second')];
    const rejected = draft(repository, 'third');
    for (const id of approved) service.review(id, { decision: 'approve' });
    service.review(rejected, { decision: 'reject', reason: 'duplicate' });

    expect(repository.reviewTally()).toEqual({ approved: 2, rejected: 1 });
    expect(service.stats().approvalRate).toBe(0.67);
  });

  it('is 0 while nothing has been reviewed', () => {
    // Two manual notes (active on arrival — a human wrote them) and one the user
    // archived: the old proxy read this as 2/3, i.e. a review that never happened.
    service.createManual({ title: 'manual one', body: 'b' });
    service.createManual({ title: 'manual two', body: 'b' });
    const archived = service.createManual({ title: 'manual three', body: 'b' });
    if (!archived.ok) throw new Error('create failed');
    service.archive(archived.note.id);

    expect(repository.reviewTally()).toEqual({ approved: 0, rejected: 0 });
    expect(service.stats().approvalRate).toBe(0);
  });

  it('ignores expiry, which archives a draft without a verdict', () => {
    const approved = draft(repository, 'approved one');
    service.review(approved, { decision: 'approve' });
    // Two drafts the TTL takes: `expired` is a lifecycle move, so neither the
    // numerator nor the denominator may see them.
    draft(repository, 'stale one', Date.now() - 5 * DAY_MS);
    draft(repository, 'stale two', Date.now() - 5 * DAY_MS);
    repository.expireDrafts(1);

    expect(repository.reviewTally()).toEqual({ approved: 1, rejected: 0 });
    expect(service.stats().approvalRate).toBe(1);
  });

  it('counts a note once, even though restoring it logs another approve', () => {
    const id = draft(repository, 'restored one');
    service.review(id, { decision: 'approve' });
    service.archive(id);
    // `restore()` goes through the same `setStatus` branch as approval, so a
    // second `approve` event lands for the same note. One note is one approval.
    service.restore(id);

    expect(repository.reviewTally().approved).toBe(1);
    expect(service.stats().approvalRate).toBe(1);
  });
});
