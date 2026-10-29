/**
 * Scope isolation (migration-v22): one database, several conversations.
 *
 * The failure this pins is the reason the column exists: `knowledge_pages` sits
 * behind Feishu, Telegram, WeChat, QQ, cron and the WebUI at once, so without a
 * scope a page curated in one group chat answered questions in every other chat,
 * and `findByTitleOrAlias` let a curation in chat B silently rewrite chat A's
 * page on the same subject.
 *
 * Every assertion below is one half of that, from the reader's or the writer's
 * side:
 *
 * - a chat reads its own pages and `global` ones, never another chat's;
 * - two chats can hold the same slug without one clobbering the other;
 * - an update is addressed, so it cannot reach a page in a scope it cannot read;
 * - a wikilink into another chat's page stays in the body and is reported
 *   dangling instead of becoming a stored link that leaks the other page's
 *   existence as a backlink.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createKnowledgeService } from '../../src/memory/knowledge/service.js';
import type { KnowledgeService } from '../../src/memory/knowledge/service-contract.js';
import type { CreateKnowledgePageInput } from '../../src/memory/knowledge/types.js';
import { openSeededDatabase, TWO_MEMORY_SOURCES } from './fixtures.js';

const CHAT_A = 'feishu:oc_a';
const CHAT_B = 'telegram:42';

describe('page scope isolation', () => {
  let db: Database.Database;
  let service: KnowledgeService;

  beforeEach(() => {
    db = openSeededDatabase();
    service = createKnowledgeService({ db });
  });

  afterEach(() => {
    db.close();
  });

  function page(overrides: Partial<CreateKnowledgePageInput> = {}): CreateKnowledgePageInput {
    return {
      pageType: 'topic',
      slug: 'deploy-process',
      title: 'Deploy process',
      content: 'Deployment runs through the release script; see [[project/ohmyagent]].',
      sources: TWO_MEMORY_SOURCES,
      ...overrides,
    };
  }

  it('shows a chat its own page and a global page, and nothing from another chat', () => {
    expect(service.create(page(), { actor: 'agent', scope: CHAT_A }).ok).toBe(true);
    expect(
      service.create(
        page({ slug: 'console-note', title: 'Console note', content: 'Deploy note for everyone.' }),
        { actor: 'user', scope: 'global' },
      ).ok,
    ).toBe(true);
    expect(
      service.create(page({ slug: 'other-group', title: 'Other group deploy' }), {
        actor: 'agent',
        scope: CHAT_B,
      }).ok,
    ).toBe(true);

    const inA = service.search('deploy', { scope: CHAT_A }).map((hit) => hit.slug);
    expect(inA).toContain('deploy-process');
    expect(inA).toContain('console-note');
    expect(inA).not.toContain('other-group');

    const inB = service.search('deploy', { scope: CHAT_B }).map((hit) => hit.slug);
    expect(inB).toContain('other-group');
    expect(inB).toContain('console-note');
    expect(inB).not.toContain('deploy-process');

    // The console browses everything: scope is a read filter, not an entitlement.
    const everywhere = service.search('deploy').map((hit) => hit.slug);
    expect(everywhere).toEqual(expect.arrayContaining(['deploy-process', 'other-group']));
  });

  it('lets two chats hold the same slug, each reading its own copy', () => {
    expect(
      service.create(page({ content: 'Chat A deploys from the phone.' }), {
        actor: 'agent',
        scope: CHAT_A,
      }).ok,
    ).toBe(true);
    expect(
      service.create(page({ content: 'Chat B deploys from CI.' }), {
        actor: 'agent',
        scope: CHAT_B,
      }).ok,
    ).toBe(true);

    expect(service.get({ slug: 'deploy-process' }, { scope: CHAT_A })?.page.content).toContain(
      'phone',
    );
    expect(service.get({ slug: 'deploy-process' }, { scope: CHAT_B })?.page.content).toContain(
      'CI',
    );

    // Two rows, not one row overwritten — the count is the actual invariant.
    const rows = db
      .prepare('SELECT COUNT(*) AS n FROM knowledge_pages WHERE slug = ?')
      .get('deploy-process') as { n: number };
    expect(rows.n).toBe(2);
  });

  it('refuses an update addressed at another chat’s page instead of rewriting it', () => {
    const created = service.create(page(), { actor: 'agent', scope: CHAT_A });
    expect(created.ok).toBe(true);

    const hijack = service.update(
      { slug: 'deploy-process' },
      { content: 'Rewritten from chat B.', expectedVersion: 1 },
      { actor: 'agent', scope: CHAT_B },
    );
    expect(hijack).toMatchObject({ ok: false, code: 'not_found' });

    // ...and chat A's body is untouched.
    expect(service.get({ slug: 'deploy-process' }, { scope: CHAT_A })?.page.content).toContain(
      'release script',
    );

    // Chat A can update its own page.
    const own = service.update(
      { slug: 'deploy-process' },
      { content: 'Deployment runs from the phone.', expectedVersion: 1 },
      { actor: 'agent', scope: CHAT_A },
    );
    expect(own).toMatchObject({ ok: true, version: 2 });
  });

  it('keeps a wikilink into another scope as text, reported dangling', () => {
    // A project page everybody can see, and one only chat B can see.
    expect(
      service.create(page({ pageType: 'project', slug: 'ohmyagent', title: 'OhMyAgent' }), {
        actor: 'user',
        scope: 'global',
      }).ok,
    ).toBe(true);
    expect(
      service.create(page({ slug: 'secret-runbook', title: 'Secret runbook' }), {
        actor: 'agent',
        scope: CHAT_B,
      }).ok,
    ).toBe(true);

    const written = service.create(
      page({ content: 'Deploy: [[topic/secret-runbook]] and [[project/ohmyagent]].' }),
      { actor: 'agent', scope: CHAT_A },
    );
    expect(written.ok).toBe(true);
    if (!written.ok) return;

    // B's page is not resolvable from A, so the link is dangling there.
    expect(written.danglingLinks).toContain('topic/secret-runbook');
    expect(written.danglingLinks).not.toContain('project/ohmyagent');

    // No stored link row pointing into the other chat: the body keeps the text,
    // the graph does not learn about a page the reader cannot open.
    const stored = db
      .prepare(
        `SELECT p.scope AS scope FROM knowledge_links l
           JOIN knowledge_pages p ON p.id = l.to_page_id
          WHERE l.from_page_id = (SELECT id FROM knowledge_pages
                                   WHERE slug = 'deploy-process' AND scope = ?)`,
      )
      .all(CHAT_A) as Array<{ scope: string }>;
    expect(stored.every((row) => row.scope === 'global')).toBe(true);
  });

  it('lists per scope, and the whole install when no scope is asked', () => {
    service.create(page(), { actor: 'agent', scope: CHAT_A });
    service.create(page({ slug: 'b-page', title: 'B page' }), { actor: 'agent', scope: CHAT_B });

    expect(service.list({ scope: CHAT_A }).map((p) => p.slug)).toEqual(['deploy-process']);
    expect(
      service
        .list()
        .map((p) => p.slug)
        .sort(),
    ).toEqual(['b-page', 'deploy-process']);
  });
});
