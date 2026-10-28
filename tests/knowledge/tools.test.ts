/**
 * The three knowledge tools, at the definition level.
 *
 * What matters here is what the *model* sees and what the policy layer reads:
 * exact tool names (a rename silently drops the tool from a profile allowlist),
 * `deferrable: true` (so five tools do not become resident schema), a capability
 * that does not fail closed to "mutating" for the read tools, and the write
 * tool's version-conflict contract — it must return the current body, not
 * overwrite it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { ToolExecutionContext } from '../../src/tools/platform/tool-context.js';
import { createKnowledgeSearchToolDefinition } from '../../src/tools/builtins/knowledge/search-definition.js';
import {
  createKnowledgeGetToolDefinition,
  parseKnowledgeRef,
} from '../../src/tools/builtins/knowledge/get-definition.js';
import { createKnowledgeWriteToolDefinition } from '../../src/tools/builtins/knowledge/write-definition.js';
import { createKnowledgeService } from '../../src/memory/knowledge/service.js';
import type { KnowledgeService } from '../../src/memory/knowledge/service-contract.js';
import { MEMORY_A, openSeededDatabase, TWO_MEMORY_SOURCES } from './fixtures.js';

const ctx = {} as unknown as ToolExecutionContext;

describe('knowledge tool definitions', () => {
  let db: Database.Database;
  let service: KnowledgeService;

  beforeEach(() => {
    db = openSeededDatabase();
    service = createKnowledgeService({ db });
  });

  afterEach(() => {
    db.close();
  });

  function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
    return result.content.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('\n');
  }

  describe('capabilities', () => {
    it('marks both readers read-only with no approval prompt', () => {
      for (const tool of [
        createKnowledgeSearchToolDefinition({ knowledgeService: service }),
        createKnowledgeGetToolDefinition({ knowledgeService: service }),
      ]) {
        expect(tool.capability).toEqual({
          category: 'memory',
          readOnly: true,
          readsFiles: false,
          writesFiles: false,
          usesShell: false,
          usesNetwork: false,
          usesComputerUse: false,
          pathAccess: 'none',
          approvalDefault: 'none',
        });
        expect(tool.deferrable).toBe(true);
        expect(tool.category).toBe('memory');
      }
    });

    it('marks the writer mutating, like file_write', () => {
      const tool = createKnowledgeWriteToolDefinition({ knowledgeService: service });
      expect(tool.capability).toEqual({
        category: 'memory',
        readOnly: false,
        readsFiles: false,
        writesFiles: false,
        usesShell: false,
        usesNetwork: false,
        usesComputerUse: false,
        pathAccess: 'none',
        approvalDefault: 'mutating',
      });
      expect(tool.deferrable).toBe(true);
    });

    it('uses the exact names the profile allowlist expects', () => {
      expect(createKnowledgeSearchToolDefinition({ knowledgeService: service }).name).toBe(
        'knowledge_search',
      );
      expect(createKnowledgeGetToolDefinition({ knowledgeService: service }).name).toBe(
        'knowledge_get',
      );
      expect(createKnowledgeWriteToolDefinition({ knowledgeService: service }).name).toBe(
        'knowledge_write',
      );
    });

    it('declares a JSON-schema parameter shape the model can read', () => {
      const write = createKnowledgeWriteToolDefinition({ knowledgeService: service });
      const schema = write.parametersSchema as {
        type: string;
        properties: Record<string, unknown>;
        required: string[];
      };

      expect(schema.type).toBe('object');
      expect(Object.keys(schema.properties).sort()).toEqual([
        'content',
        'expectedVersion',
        'pageType',
        'reason',
        'slug',
        'sources',
        'tags',
        'title',
      ]);
      expect(schema.required).toEqual(
        expect.arrayContaining(['pageType', 'slug', 'title', 'content', 'sources']),
      );

      const search = createKnowledgeSearchToolDefinition({ knowledgeService: service });
      expect(Object.keys((search.parametersSchema as { properties: object }).properties)).toEqual(
        expect.arrayContaining(['query', 'limit', 'pageType', 'tag']),
      );
    });
  });

  describe('knowledge_search', () => {
    it('returns slug, title and a snippet', async () => {
      service.create(
        {
          pageType: 'topic',
          slug: 'excel-etl',
          title: 'Excel ETL',
          content: '用 Power Query 替代手工 VLOOKUP。',
          sources: TWO_MEMORY_SOURCES,
        },
        { actor: 'agent' },
      );

      const tool = createKnowledgeSearchToolDefinition({ knowledgeService: service });
      const result = await tool.execute({ query: 'Power Query' }, ctx);

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('topic/excel-etl');
      expect(textOf(result)).toContain('Excel ETL');
      expect(result.metadata).toMatchObject({ count: 1 });
    });

    it('says so when nothing matches', async () => {
      const tool = createKnowledgeSearchToolDefinition({ knowledgeService: service });
      const result = await tool.execute({ query: 'nothing here' }, ctx);

      expect(textOf(result)).toContain('No knowledge pages matched');
    });

    it('rejects an empty query before touching the service', async () => {
      const tool = createKnowledgeSearchToolDefinition({ knowledgeService: service });
      const result = await tool.execute({ query: '' }, ctx);

      expect(result.isError).toBe(true);
    });
  });

  describe('knowledge_get', () => {
    beforeEach(() => {
      service.create(
        {
          pageType: 'topic',
          slug: 'excel-etl',
          title: 'Excel ETL',
          content: '正文第一段。\n\n见 [[power-query]]。',
          sources: TWO_MEMORY_SOURCES,
        },
        { actor: 'agent' },
      );
    });

    it('returns the body, its citations and its links', async () => {
      const tool = createKnowledgeGetToolDefinition({ knowledgeService: service });
      const result = await tool.execute({ ref: 'topic/excel-etl' }, ctx);
      const text = textOf(result);

      expect(text).toContain('正文第一段。');
      expect(text).toContain('sources: memory:');
      expect(text).toContain('power-query (missing)');
      expect(result.metadata).toMatchObject({ slug: 'excel-etl', version: 1, truncated: false });
    });

    it('accepts a bare slug and an id', async () => {
      const page = service.list()[0];
      const tool = createKnowledgeGetToolDefinition({ knowledgeService: service });

      expect(textOf(await tool.execute({ ref: 'excel-etl' }, ctx))).toContain('正文第一段。');
      expect(textOf(await tool.execute({ ref: page.id }, ctx))).toContain('正文第一段。');
    });

    it('truncates a long body and says so', async () => {
      const page = service.list()[0];
      service.update(
        { id: page.id },
        { content: 'x'.repeat(5000), expectedVersion: 1 },
        { actor: 'agent' },
      );

      const tool = createKnowledgeGetToolDefinition({ knowledgeService: service });
      const result = await tool.execute({ ref: 'excel-etl', maxChars: 400 }, ctx);

      expect(result.metadata).toMatchObject({ truncated: true, contentLength: 5000 });
      expect(textOf(result)).toContain('truncated to 400');
    });

    it('reports a miss as an error result', async () => {
      const tool = createKnowledgeGetToolDefinition({ knowledgeService: service });
      const result = await tool.execute({ ref: 'nope' }, ctx);

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('No knowledge page found');
    });
  });

  describe('parseKnowledgeRef', () => {
    it('distinguishes ids, typed slugs and plain slugs', () => {
      expect(parseKnowledgeRef('3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6a7b')).toEqual({
        id: '3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6a7b',
      });
      expect(parseKnowledgeRef('topic/excel-etl')).toEqual({
        slug: 'excel-etl',
        pageType: 'topic',
      });
      expect(parseKnowledgeRef('excel-etl')).toEqual({ slug: 'excel-etl' });
      // A prefix that is not a page type stays part of the slug.
      expect(parseKnowledgeRef('notes/2024')).toEqual({ slug: 'notes/2024' });
    });
  });

  describe('knowledge_write', () => {
    const baseArgs = {
      pageType: 'topic' as const,
      slug: 'excel-etl',
      title: 'Excel ETL',
      content: '第一版正文',
      sources: TWO_MEMORY_SOURCES,
    };

    it('creates a page', async () => {
      const tool = createKnowledgeWriteToolDefinition({ knowledgeService: service });
      const result = await tool.execute(baseArgs, ctx);

      expect(textOf(result)).toContain('Created topic/excel-etl (version 1, status active)');
      expect(result.metadata).toMatchObject({ created: true, version: 1, status: 'active' });
    });

    it('returns the current body instead of clobbering when no version is passed', async () => {
      const tool = createKnowledgeWriteToolDefinition({ knowledgeService: service });
      await tool.execute(baseArgs, ctx);

      const conflict = await tool.execute({ ...baseArgs, content: '悄悄覆盖' }, ctx);

      // A conflict is a retry hint, not a failure: it must not be flagged as an
      // error, and it must carry the body so the model can re-merge.
      expect(conflict.isError).toBeFalsy();
      expect(conflict.metadata).toMatchObject({ code: 'version_conflict', currentVersion: 1 });
      expect(textOf(conflict)).toContain('version_conflict');
      expect(textOf(conflict)).toContain('第一版正文');
      expect(service.get({ slug: 'excel-etl' })?.page.content).toBe('第一版正文');
    });

    it('updates when the version that was read is passed', async () => {
      const tool = createKnowledgeWriteToolDefinition({ knowledgeService: service });
      await tool.execute(baseArgs, ctx);

      const updated = await tool.execute(
        { ...baseArgs, content: '第二版正文', expectedVersion: 1 },
        ctx,
      );

      expect(textOf(updated)).toContain('Updated topic/excel-etl (version 2');
      expect(service.get({ slug: 'excel-etl' })?.page.content).toBe('第二版正文');
    });

    it('refuses a stale version', async () => {
      const tool = createKnowledgeWriteToolDefinition({ knowledgeService: service });
      await tool.execute(baseArgs, ctx);
      await tool.execute({ ...baseArgs, content: '第二版正文', expectedVersion: 1 }, ctx);

      const stale = await tool.execute(
        { ...baseArgs, content: '第三版正文', expectedVersion: 1 },
        ctx,
      );

      expect(stale.metadata).toMatchObject({ code: 'version_conflict', currentVersion: 2 });
      expect(textOf(stale)).toContain('第二版正文');
    });

    it('refuses a citation that does not exist', async () => {
      const tool = createKnowledgeWriteToolDefinition({ knowledgeService: service });
      const result = await tool.execute(
        { ...baseArgs, sources: [{ kind: 'memory', id: 'memory-invented' }] },
        ctx,
      );

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('unknown_sources');
      expect(textOf(result)).toContain('memory:memory-invented');
      expect(service.list()).toEqual([]);
    });

    it('refuses a page type outside the closed set', async () => {
      const tool = createKnowledgeWriteToolDefinition({ knowledgeService: service });
      const result = await tool.execute({ ...baseArgs, pageType: 'person' } as never, ctx);

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Invalid arguments');
      expect(service.list()).toEqual([]);
    });

    it('reports dangling links without failing the write', async () => {
      const tool = createKnowledgeWriteToolDefinition({ knowledgeService: service });
      const result = await tool.execute({ ...baseArgs, content: '见 [[not-written-yet]]' }, ctx);

      expect(textOf(result)).toContain('Dangling links');
      expect(textOf(result)).toContain('not-written-yet');
      expect(result.metadata).toMatchObject({ danglingLinks: ['not-written-yet'] });
    });

    it('accepts a message citation as well as a memory one', async () => {
      const tool = createKnowledgeWriteToolDefinition({ knowledgeService: service });
      const result = await tool.execute(
        { ...baseArgs, sources: [{ kind: 'memory', id: MEMORY_A }] },
        ctx,
      );
      expect(result.isError).toBeFalsy();
    });
  });
});
