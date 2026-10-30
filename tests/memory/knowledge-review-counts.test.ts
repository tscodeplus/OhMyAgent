/**
 * The review queue's evidence counts must agree with the admission rule.
 *
 * `GET /api/knowledge/pending` reports two numbers per draft — total citations and
 * independent conversations — and the second one exists for exactly one purpose:
 * to tell the reviewer what admission rule 2 measured. It is therefore a second
 * implementation of `countIndependentSources` (`curate.ts`), written in SQL because
 * the queue renders 50 rows and a per-row query is 50 round trips on a phone.
 *
 * Two implementations of one definition drift. This test holds them together with
 * the cases the definition actually has to survive:
 *
 *   - a page citing two memories from the *same* conversation is one witness
 *     (four rows from one chat is the inflation the rule exists to prevent);
 *   - a citation without a conversation — a shared message — is its own witness,
 *     because folding unrelated rows together would refuse real recurrence;
 *   - different conversations of the same panel add up.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/memory/db.js';
import { KnowledgeRepository } from '../../src/memory/knowledge/repository.js';
import { createKnowledgeService } from '../../src/memory/knowledge/service.js';
import { countIndependentSources } from '../../src/memory/knowledge/curate.js';
import type { KnowledgeService } from '../../src/memory/knowledge/service-contract.js';
import type { KnowledgeSourceInput } from '../../src/memory/knowledge/types.js';

const NOW = 1_780_000_000_000;

/** Memory id → the conversation (`memories.scope_key`) it was written in. */
const CONVERSATIONS: Record<string, string> = {
  'mem-same-1': 'session-alpha',
  'mem-same-2': 'session-alpha',
  'mem-other': 'session-beta',
  'mem-third': 'session-gamma',
  'mem-anon': '',
};

describe('review queue evidence counts', () => {
  let db: Database.Database;
  let service: KnowledgeService;
  let repository: KnowledgeRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    service = createKnowledgeService({ db });
    repository = new KnowledgeRepository(db);
    const at = String(NOW);
    const insert = db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, confidence, created_at, updated_at)
       VALUES (?, 'user', ?, 'fact', ?, 1, ?, ?)`,
    );
    for (const [id, scopeKey] of Object.entries(CONVERSATIONS)) {
      insert.run(id, scopeKey, `content for ${id}`, at, at);
    }
    // A shared message, deliberately in the *same* conversation as `mem-same-1`:
    // the curator counts a message as its own witness (it has no `conversationKey`),
    // so an implementation that joined `messages.session_id` would answer 1 where
    // the rule answers 2 — which is what makes the shared-message case below a real
    // guard rather than a coincidence.
    db.prepare(
      `INSERT INTO sessions (id, chat_id, user_id, channel, created_at, updated_at)
       VALUES ('session-alpha', 'chat-alpha', 'user-1', 'webui', ?, ?)`,
    ).run(at, at);
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, created_at)
       VALUES ('msg-shared', 'session-alpha', 'user', 'shared message body', ?)`,
    ).run(at);
  });

  afterEach(() => {
    db.close();
  });

  /**
   * Write a page and return the id.
   *
   * `enforceAdmission: false` on purpose: this test is about what the queue
   * *reports*, and a page that admission would refuse is exactly the case worth
   * reporting on — a single-conversation draft is the one a reviewer most needs to
   * see flagged.
   */
  function seedPage(slug: string, sources: KnowledgeSourceInput[]): string {
    const result = service.create(
      {
        pageType: 'topic',
        slug,
        title: `Page ${slug}`,
        content: `body about ${slug}`,
        sources,
        updatedBy: 'system',
      },
      { actor: 'system', enforceAdmission: false },
    );
    if (!result.ok) throw new Error(`seed failed: ${result.code}`);
    return result.id;
  }

  /** The curator's count, over the same citations, read straight from the DB. */
  function independentViaCurator(sources: readonly KnowledgeSourceInput[]): number {
    return countIndependentSources(
      sources.map((source) => ({
        kind: source.kind,
        id: source.id,
        content: '',
        scope: 'user',
        confidence: 1,
        // The curator takes the conversation key from `memories.scope_key` for a
        // memory and leaves it null for anything else (`toCurateSource`).
        conversationKey:
          source.kind === 'memory' ? (CONVERSATIONS[source.id] ?? null) || null : null,
      })),
    );
  }

  function expectAgreement(slug: string, sources: KnowledgeSourceInput[]): void {
    const id = seedPage(slug, sources);
    const counts = repository.countSourcesByPage([id]);
    const counted = counts.get(id);
    expect(counted).toBeDefined();
    expect(counted?.total).toBe(sources.length);
    expect(counted?.independent).toBe(independentViaCurator(sources));
  }

  it('does not count two memories from one conversation as two witnesses', () => {
    expectAgreement('same-conversation', [
      { kind: 'memory', id: 'mem-same-1' },
      { kind: 'memory', id: 'mem-same-2' },
    ]);
    // Asserted literally as well, so a change that breaks both definitions in the
    // same way still fails: this is the number the reviewer reads.
    const id = seedPage('same-conversation-again', [
      { kind: 'memory', id: 'mem-same-1' },
      { kind: 'memory', id: 'mem-same-2' },
    ]);
    expect(repository.countSourcesByPage([id]).get(id)).toEqual({ total: 2, independent: 1 });
  });

  it('counts different conversations of one page separately', () => {
    expectAgreement('three-conversations', [
      { kind: 'memory', id: 'mem-same-1' },
      { kind: 'memory', id: 'mem-other' },
      { kind: 'memory', id: 'mem-third' },
    ]);
  });

  it('counts a citation with no conversation as its own source', () => {
    // A shared message has no `scope_key`; it must not vanish into another row's
    // conversation, and it must not be folded into a page's single witness.
    expectAgreement('shared-message', [
      { kind: 'memory', id: 'mem-same-1' },
      { kind: 'message', id: 'msg-shared' },
    ]);
  });

  it('treats an empty scope_key as no conversation, matching the curator', () => {
    expectAgreement('empty-scope-key', [
      { kind: 'memory', id: 'mem-anon' },
      { kind: 'memory', id: 'mem-same-1' },
    ]);
  });

  it('answers with one query for a batch and omits pages with no citations', () => {
    const first = seedPage('batch-a', [{ kind: 'memory', id: 'mem-same-1' }]);
    const second = seedPage('batch-b', [
      { kind: 'memory', id: 'mem-other' },
      { kind: 'memory', id: 'mem-third' },
    ]);
    const counts = repository.countSourcesByPage([first, second, 'no-such-page']);
    expect(counts.size).toBe(2);
    expect(counts.get(first)).toEqual({ total: 1, independent: 1 });
    expect(counts.get(second)).toEqual({ total: 2, independent: 2 });
    expect(repository.countSourcesByPage([]).size).toBe(0);
  });
});
