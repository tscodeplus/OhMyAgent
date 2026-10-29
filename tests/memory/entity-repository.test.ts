import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrateV10 } from '../../src/memory/migration-v10';
import {
  EntityRepository,
  canonicalizeEntityName,
} from '../../src/memory/repositories/entity-repository';

describe('EntityRepository', () => {
  let db: Database.Database;
  let repo: EntityRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrateV10(db);
    repo = new EntityRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('canonicalizeEntityName', () => {
    it('folds case, spaces and separators into one identity', () => {
      // Separators are not identity (migration v19): `Oh My Agent` / `oh-my-agent`
      // / `OhMyAgent` are one node, and a memory that wrote one form used to be
      // unreachable from a query that wrote another.
      expect(canonicalizeEntityName('  Alice   SMITH ')).toBe('alicesmith');
      expect(canonicalizeEntityName('Oh My Agent')).toBe(canonicalizeEntityName('oh-my-agent'));
      expect(canonicalizeEntityName('IndexTTS-2')).toBe(canonicalizeEntityName('IndexTTS2'));
      expect(canonicalizeEntityName('张三')).toBe('张三');
      // Dots stay: a version separator and a domain are not the same thing.
      expect(canonicalizeEntityName('Node.js')).toBe('node.js');
    });
  });

  describe('upsertEntity', () => {
    it('dedupes by canonical name and type', () => {
      const first = repo.upsertEntity({ name: 'Alice', entityType: 'person' });
      const second = repo.upsertEntity({ name: '  ALICE  ', entityType: 'person' });

      expect(second.id).toBe(first.id);
      expect(repo.entityCount()).toBe(1);
      expect(second.name).toBe('Alice'); // the first spelling wins
    });

    it('keeps the same name under different types apart', () => {
      const person = repo.upsertEntity({ name: 'Mercury', entityType: 'person' });
      const project = repo.upsertEntity({ name: 'Mercury', entityType: 'project' });
      expect(project.id).not.toBe(person.id);
      expect(repo.entityCount()).toBe(2);
    });

    it('matches an existing entity by alias before inserting', () => {
      const alice = repo.upsertEntity({ name: 'Alice', entityType: 'person', aliases: ['Ally'] });
      const again = repo.upsertEntity({ name: 'Ally', entityType: 'person' });

      expect(again.id).toBe(alice.id);
      expect(repo.entityCount()).toBe(1);
    });

    it('does not match an alias belonging to another entity type', () => {
      repo.upsertEntity({ name: 'Apple', entityType: 'person', aliases: ['fruit co'] });
      const company = repo.upsertEntity({ name: 'Fruit Co', entityType: 'company' });

      expect(repo.entityCount()).toBe(2);
      expect(company.canonical_name).toBe('fruitco');
    });

    it('records the supplied spellings as aliases for later lookups', () => {
      repo.upsertEntity({ name: 'OhMyAgent', entityType: 'project' });
      expect(repo.findByAlias('ohmyagent', 'project')?.name).toBe('OhMyAgent');
    });

    it('stores description and refreshes it', () => {
      const created = repo.upsertEntity({
        name: 'Alice',
        entityType: 'person',
        description: 'engineer',
      });
      expect(created.description).toBe('engineer');

      const updated = repo.upsertEntity({
        name: 'Alice',
        entityType: 'person',
        description: 'staff engineer',
      });
      expect(updated.id).toBe(created.id);
      expect(updated.description).toBe('staff engineer');
    });

    it('rejects an empty name', () => {
      expect(() => repo.upsertEntity({ name: '   ', entityType: 'person' })).toThrow();
    });
  });

  describe('addAlias / findByAlias', () => {
    it('is idempotent per (entity, alias)', () => {
      const entity = repo.upsertEntity({ name: 'Alice', entityType: 'person' });
      expect(repo.addAlias(entity.id, 'A. Smith')).toBe(true);
      expect(repo.addAlias(entity.id, 'a.  smith')).toBe(false);
      expect(repo.findByAlias('A. Smith')?.id).toBe(entity.id);
    });
  });

  describe('linkEntities', () => {
    it('dedupes the same triple and refreshes valid_from', () => {
      const alice = repo.upsertEntity({ name: 'Alice', entityType: 'person' });
      const project = repo.upsertEntity({ name: 'OhMyAgent', entityType: 'project' });

      const first = repo.linkEntities({
        sourceId: alice.id,
        targetId: project.id,
        relationType: 'works_on',
        validFrom: 1_000,
      });
      const second = repo.linkEntities({
        sourceId: alice.id,
        targetId: project.id,
        relationType: 'works_on',
        validFrom: 2_000,
        confidence: 0.7,
      });

      expect(second.id).toBe(first.id);
      expect(second.valid_from).toBe(2_000);
      expect(second.confidence).toBe(0.7);
      expect(db.prepare('SELECT COUNT(*) AS cnt FROM entity_edges').get()).toEqual({ cnt: 1 });
    });

    it('treats different relation types as separate edges', () => {
      const alice = repo.upsertEntity({ name: 'Alice', entityType: 'person' });
      const tea = repo.upsertEntity({ name: 'tea', entityType: 'thing' });

      repo.linkEntities({ sourceId: alice.id, targetId: tea.id, relationType: 'likes' });
      repo.linkEntities({ sourceId: alice.id, targetId: tea.id, relationType: 'owns' });

      expect(db.prepare('SELECT COUNT(*) AS cnt FROM entity_edges').get()).toEqual({ cnt: 2 });
    });

    it('stores provenance columns', () => {
      const alice = repo.upsertEntity({ name: 'Alice', entityType: 'person' });
      const tea = repo.upsertEntity({ name: 'tea', entityType: 'thing' });
      const edge = repo.linkEntities({
        sourceId: alice.id,
        targetId: tea.id,
        relationType: 'likes',
        sourceMemoryId: 'mem-1',
        sourceMessageId: 'msg-1',
        confidence: 0.9,
      });

      expect(edge.source_memory_id).toBe('mem-1');
      expect(edge.source_message_id).toBe('msg-1');
      expect(edge.confidence).toBe(0.9);
      expect(edge.valid_to).toBeNull();
    });
  });

  describe('neighbors', () => {
    function buildChain() {
      const alice = repo.upsertEntity({ name: 'Alice', entityType: 'person' });
      const project = repo.upsertEntity({ name: 'OhMyAgent', entityType: 'project' });
      const city = repo.upsertEntity({ name: 'Shanghai', entityType: 'place' });
      repo.linkEntities({ sourceId: alice.id, targetId: project.id, relationType: 'works_on' });
      repo.linkEntities({ sourceId: alice.id, targetId: city.id, relationType: 'lives_in' });
      return { alice, project, city };
    }

    it('returns direct neighbours at depth 1 by default', () => {
      const { alice, project, city } = buildChain();
      const neighbors = repo.neighbors(alice.id);

      expect(neighbors).toHaveLength(2);
      expect(neighbors.map((n) => n.entity.id).sort()).toEqual([project.id, city.id].sort());
      expect(neighbors.every((n) => n.depth === 1)).toBe(true);
    });

    it('treats edges as undirected', () => {
      const { project, alice } = buildChain();
      const neighbors = repo.neighbors(project.id);
      expect(neighbors.map((n) => n.entity.id)).toEqual([alice.id]);
    });

    it('reaches two hops when depth is 2', () => {
      const { alice, project, city } = buildChain();
      const colleague = repo.upsertEntity({ name: 'Bob', entityType: 'person' });
      repo.linkEntities({ sourceId: project.id, targetId: colleague.id, relationType: 'knows' });

      const neighbors = repo.neighbors(alice.id, { depth: 2 });
      const byId = new Map(neighbors.map((n) => [n.entity.id, n]));

      expect(byId.get(project.id)?.depth).toBe(1);
      expect(byId.get(colleague.id)?.depth).toBe(2);
      expect(byId.get(city.id)?.depth).toBe(1);
    });

    it('filters by relation type', () => {
      const { alice, city } = buildChain();
      const neighbors = repo.neighbors(alice.id, { relationTypes: ['lives_in'] });

      expect(neighbors).toHaveLength(1);
      expect(neighbors[0].entity.id).toBe(city.id);
      expect(neighbors[0].relationType).toBe('lives_in');
    });

    it('honours asOf: a retracted edge is invisible after the retraction', () => {
      const alice = repo.upsertEntity({ name: 'Alice', entityType: 'person' });
      const city = repo.upsertEntity({ name: 'Shanghai', entityType: 'place' });
      const edge = repo.linkEntities({
        sourceId: alice.id,
        targetId: city.id,
        relationType: 'lives_in',
        validFrom: 1_000,
      });

      expect(repo.neighbors(alice.id, { asOf: 1_500 })).toHaveLength(1);

      expect(repo.retractEdge(edge.id, 2_000)).toBe(true);
      // Still true in June (before the retraction) …
      expect(repo.neighbors(alice.id, { asOf: 1_500 })).toHaveLength(1);
      // … not true after it.
      expect(repo.neighbors(alice.id, { asOf: 2_500 })).toHaveLength(0);
      // The row survives retraction — history stays queryable.
      expect(db.prepare('SELECT COUNT(*) AS cnt FROM entity_edges').get()).toEqual({ cnt: 1 });
      expect(repo.retractEdge(edge.id, 3_000)).toBe(false);
    });

    it('ignores an edge that starts after asOf', () => {
      const alice = repo.upsertEntity({ name: 'Alice', entityType: 'person' });
      const city = repo.upsertEntity({ name: 'Shanghai', entityType: 'place' });
      repo.linkEntities({
        sourceId: alice.id,
        targetId: city.id,
        relationType: 'lives_in',
        validFrom: 5_000,
      });

      expect(repo.neighbors(alice.id, { asOf: 4_000 })).toHaveLength(0);
      expect(repo.neighbors(alice.id, { asOf: 6_000 })).toHaveLength(1);
    });

    it('terminates on a cycle and reports each entity once', () => {
      const a = repo.upsertEntity({ name: 'A', entityType: 'node' });
      const b = repo.upsertEntity({ name: 'B', entityType: 'node' });
      const c = repo.upsertEntity({ name: 'C', entityType: 'node' });
      repo.linkEntities({ sourceId: a.id, targetId: b.id, relationType: 'knows' });
      repo.linkEntities({ sourceId: b.id, targetId: c.id, relationType: 'knows' });
      repo.linkEntities({ sourceId: c.id, targetId: a.id, relationType: 'knows' });

      const neighbors = repo.neighbors(a.id, { depth: 5 });

      expect(neighbors.map((n) => n.entity.id).sort()).toEqual([b.id, c.id].sort());
      expect(neighbors.every((n) => n.depth > 0 && n.depth <= 5)).toBe(true);
    });

    it('respects the result limit', () => {
      const hub = repo.upsertEntity({ name: 'hub', entityType: 'node' });
      for (let i = 0; i < 5; i++) {
        const leaf = repo.upsertEntity({ name: `leaf-${i}`, entityType: 'node' });
        repo.linkEntities({ sourceId: hub.id, targetId: leaf.id, relationType: 'part_of' });
      }

      expect(repo.neighbors(hub.id, { limit: 3 })).toHaveLength(3);
    });
  });

  describe('searchEntities', () => {
    beforeEach(() => {
      repo.upsertEntity({ name: 'Alice Chen', entityType: 'person', aliases: ['Ally'] });
      repo.upsertEntity({ name: 'Alice Project', entityType: 'project' });
      repo.upsertEntity({ name: '张三', entityType: 'person' });
    });

    it('matches on canonical name substring, exact first', () => {
      const results = repo.searchEntities('alice');
      expect(results.map((entity) => entity.name)).toEqual(['Alice Chen', 'Alice Project']);
    });

    it('matches on alias', () => {
      expect(repo.searchEntities('ally').map((entity) => entity.name)).toEqual(['Alice Chen']);
    });

    it('matches CJK names', () => {
      expect(repo.searchEntities('张三').map((entity) => entity.name)).toEqual(['张三']);
    });

    it('returns nothing for an empty query and respects the limit', () => {
      expect(repo.searchEntities('   ')).toEqual([]);
      expect(repo.searchEntities('alice', 1)).toHaveLength(1);
    });

    it('does not treat LIKE wildcards as wildcards', () => {
      expect(repo.searchEntities('%')).toEqual([]);
      expect(repo.searchEntities('_')).toEqual([]);
    });
  });

  describe('entityCount', () => {
    it('counts entities, not edges', () => {
      const alice = repo.upsertEntity({ name: 'Alice', entityType: 'person' });
      const tea = repo.upsertEntity({ name: 'tea', entityType: 'thing' });
      repo.linkEntities({ sourceId: alice.id, targetId: tea.id, relationType: 'likes' });

      expect(repo.entityCount()).toBe(2);
    });
  });
});
