/**
 * `service.backlinks` scope (P12 in the 2026-10-30 knowledge review): the ref
 * must resolve under the read rule (asked scope + `global`), and the linking
 * pages must be filtered under the same rule — the bare-slug call used to
 * resolve in the unscoped pool and show another chat's backlinks.
 *
 * Unscoped stays the console's view: every scope, exactly as before the option
 * existed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createKnowledgeService } from '../../src/memory/knowledge/service.js';
import type { KnowledgeService } from '../../src/memory/knowledge/service-contract.js';
import { openSeededDatabase, TWO_MEMORY_SOURCES } from './fixtures.js';

const CHAT_A = 'feishu:oc_a';
const CHAT_B = 'telegram:42';

let db: Database.Database;
let service: KnowledgeService;

beforeEach(() => {
  db = openSeededDatabase();
  service = createKnowledgeService({ db });
});

afterEach(() => {
  db.close();
});

function insert(input: {
  pageType?: 'topic' | 'project';
  slug: string;
  title: string;
  content: string;
  scope?: string;
}): string {
  const result = service.create(
    {
      pageType: input.pageType ?? 'topic',
      slug: input.slug,
      title: input.title,
      content: input.content,
      sources: TWO_MEMORY_SOURCES,
    },
    { actor: 'agent', scope: input.scope },
  );
  if (!result.ok) throw new Error(`seed ${input.slug} failed: ${result.code}`);
  return result.id;
}

describe('backlinks scope', () => {
  it('lists only the linking pages the asking scope may read', () => {
    insert({ slug: 'target', title: 'Target', content: 'The reference page.' });
    // One linker per chat, and a chat-local one somewhere else entirely.
    insert({
      slug: 'runbook-a',
      title: 'Runbook A',
      content: 'A: [[topic/target]].',
      scope: CHAT_A,
    });
    insert({
      slug: 'runbook-b',
      title: 'Runbook B',
      content: 'B: [[topic/target]].',
      scope: CHAT_B,
    });

    expect(
      service
        .backlinks({ slug: 'target', pageType: 'topic' }, { scope: CHAT_A })
        .map((b) => b.slug),
    ).toEqual(['runbook-a']);
    expect(
      service
        .backlinks({ slug: 'target', pageType: 'topic' }, { scope: CHAT_B })
        .map((b) => b.slug),
    ).toEqual(['runbook-b']);
    // Unscoped: the console sees both, unchanged — newest-first per linksTo.
    expect(service.backlinks({ slug: 'target', pageType: 'topic' }).map((b) => b.slug)).toEqual([
      'runbook-b',
      'runbook-a',
    ]);
  });

  it('resolves the ref inside the scope, never into another chat\u2019s same-slug page', () => {
    // Two chats hold the same slug; only chat B's links to the reference page.
    insert({ slug: 'guide', title: 'Guide', content: 'The guide (B copy).', scope: CHAT_B });
    insert({ slug: 'reference', title: 'Reference', content: 'Reference for B.', scope: CHAT_B });
    insert({
      slug: 'save-runbook',
      title: 'Save runbook',
      content: 'B: [[topic/reference]].',
      scope: CHAT_B,
    });

    // From chat A the target does not exist: no cross-chat read, no panel.
    expect(service.backlinks({ slug: 'reference', pageType: 'topic' }, { scope: CHAT_A })).toEqual(
      [],
    );
    // From chat B the ref resolves to B's copy and the panel shows B's linker.
    const fromB = service.backlinks({ slug: 'reference', pageType: 'topic' }, { scope: CHAT_B });
    expect(fromB.map((b) => b.slug)).toEqual(['save-runbook']);
  });

  it('returns nothing for a page that is not active, with or without scope', () => {
    const id = insert({ slug: 'target', title: 'Target', content: 'Reference.' });
    insert({ slug: 'linker', title: 'Linker', content: 'See [[topic/target]].', scope: CHAT_A });
    service.setStatus(id, 'archived', 'agent');

    expect(service.backlinks({ slug: 'target', pageType: 'topic' }, { scope: CHAT_A })).toEqual([]);
    expect(service.backlinks({ slug: 'target', pageType: 'topic' })).toEqual([]);
  });
});
