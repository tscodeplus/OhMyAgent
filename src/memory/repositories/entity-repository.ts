/**
 * EntityRepository — knowledge-graph persistence over the v10 tables
 * (`entities`, `entity_aliases`, `entity_edges`).
 *
 * Names are matched through `canonical_name` (trimmed, whitespace collapsed,
 * ASCII-lowercased) so "Alice" and "alice" are one entity, not two. Every
 * statement is prepared and every user value is bound, never interpolated.
 *
 * Edges are temporal: a fact that stops being true gets `valid_to` set instead
 * of being deleted (see migration-v10.ts), so history stays queryable.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface Entity {
  id: string;
  name: string;
  canonical_name: string;
  entity_type: string;
  description: string | null;
  created_at: number | null;
  updated_at: number | null;
}

export interface EntityEdge {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: string;
  confidence: number;
  source_memory_id: string | null;
  source_message_id: string | null;
  valid_from: number | null;
  valid_to: number | null;
  created_at: number | null;
}

export interface UpsertEntityInput {
  name: string;
  entityType: string;
  description?: string;
  aliases?: string[];
}

export interface LinkEntitiesInput {
  sourceId: string;
  targetId: string;
  relationType: string;
  confidence?: number;
  sourceMemoryId?: string;
  sourceMessageId?: string;
  validFrom?: number;
}

export interface NeighborsOptions {
  /** Hop count to traverse, 1..5. Default 1. */
  depth?: number;
  /** Restrict traversal to these relation types. */
  relationTypes?: string[];
  /** Point in time (epoch ms). Edges not valid at that instant are skipped. */
  asOf?: number;
  /** Cap on returned neighbours. Default 100. */
  limit?: number;
}

export interface EntityNeighbor {
  entity: Entity;
  /** Hops from the origin; 1 = direct neighbour. */
  depth: number;
  /** The edge that first reached this neighbour. */
  edgeId: string;
  relationType: string;
  confidence: number;
}

const MAX_DEPTH = 5;

/**
 * Canonical form used for matching: trimmed, internal whitespace collapsed to
 * one space, ASCII letters lowercased. CJK is left untouched (it has no case).
 */
export function canonicalizeEntityName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[A-Z]+/g, (match) => match.toLowerCase());
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export class EntityRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Resolve or create the entity for `input.name`.
   *
   * Lookup order: exact `canonical_name` + `entity_type` → any alias (scoped to
   * the same type, so a person "Apple" never merges into the company) → insert.
   * Whatever matched, the spellings supplied here are recorded as aliases, so
   * the next mention resolves in one step.
   */
  upsertEntity(input: UpsertEntityInput): Entity {
    const canonical = canonicalizeEntityName(input.name);
    if (!canonical) {
      throw new Error('upsertEntity: name must contain at least one non-whitespace character');
    }
    const entityType = input.entityType.trim();
    if (!entityType) {
      throw new Error('upsertEntity: entityType must not be empty');
    }

    const existing =
      this.findByName(canonical, entityType) ??
      [input.name, ...(input.aliases ?? [])]
        .map((alias) => this.findByAlias(alias, entityType))
        .find((entity): entity is Entity => entity !== undefined);

    const entity = existing ?? this.insertEntity(input.name.trim(), canonical, entityType);
    if (input.description && input.description !== entity.description) {
      this.db
        .prepare('UPDATE entities SET description = ?, updated_at = ? WHERE id = ?')
        .run(input.description, Date.now(), entity.id);
      entity.description = input.description;
    }

    for (const alias of [input.name, ...(input.aliases ?? [])]) {
      this.addAlias(entity.id, alias, 'upsert');
    }
    return this.findById(entity.id) ?? entity;
  }

  private insertEntity(name: string, canonical: string, entityType: string): Entity {
    const now = Date.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO entities (id, name, canonical_name, entity_type, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(id, name, canonical, entityType, now, now);
    return this.findById(id)!;
  }

  /**
   * Record `alias` for an entity. The alias is canonicalised on write so
   * `findByAlias` can match a differently-cased or padded mention.
   *
   * @returns true when the alias was new.
   */
  addAlias(entityId: string, alias: string, source?: string): boolean {
    const canonicalAlias = canonicalizeEntityName(alias);
    if (!canonicalAlias) return false;
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO entity_aliases (entity_id, alias, source, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(entityId, canonicalAlias, source ?? null, Date.now());
    return result.changes > 0;
  }

  findById(id: string): Entity | undefined {
    return this.db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as Entity | undefined;
  }

  findByName(name: string, entityType?: string): Entity | undefined {
    const canonical = canonicalizeEntityName(name);
    if (!canonical) return undefined;
    if (entityType) {
      return this.db
        .prepare('SELECT * FROM entities WHERE canonical_name = ? AND entity_type = ?')
        .get(canonical, entityType.trim()) as Entity | undefined;
    }
    return this.db
      .prepare('SELECT * FROM entities WHERE canonical_name = ? ORDER BY created_at LIMIT 1')
      .get(canonical) as Entity | undefined;
  }

  findByAlias(alias: string, entityType?: string): Entity | undefined {
    const canonical = canonicalizeEntityName(alias);
    if (!canonical) return undefined;
    if (entityType) {
      return this.db
        .prepare(
          `SELECT e.* FROM entities e
           JOIN entity_aliases a ON a.entity_id = e.id
           WHERE a.alias = ? AND e.entity_type = ?
           ORDER BY e.created_at LIMIT 1`,
        )
        .get(canonical, entityType.trim()) as Entity | undefined;
    }
    return this.db
      .prepare(
        `SELECT e.* FROM entities e
         JOIN entity_aliases a ON a.entity_id = e.id
         WHERE a.alias = ?
         ORDER BY e.created_at LIMIT 1`,
      )
      .get(canonical) as Entity | undefined;
  }

  /**
   * Create the SPO edge, or refresh the still-valid one that says the same
   * thing. Re-stating "Alice likes tea" must not stack duplicate edges that
   * then each need retracting.
   */
  linkEntities(input: LinkEntitiesInput): EntityEdge {
    const validFrom = input.validFrom ?? Date.now();
    const confidence = input.confidence ?? 1.0;

    const existing = this.db
      .prepare(
        `SELECT * FROM entity_edges
         WHERE source_entity_id = ? AND target_entity_id = ? AND relation_type = ? AND valid_to IS NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(input.sourceId, input.targetId, input.relationType) as EntityEdge | undefined;

    if (existing) {
      this.db
        .prepare('UPDATE entity_edges SET valid_from = ?, confidence = ? WHERE id = ?')
        .run(validFrom, confidence, existing.id);
      return this.db
        .prepare('SELECT * FROM entity_edges WHERE id = ?')
        .get(existing.id) as EntityEdge;
    }

    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO entity_edges (
           id, source_entity_id, target_entity_id, relation_type, confidence,
           source_memory_id, source_message_id, valid_from, valid_to, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        id,
        input.sourceId,
        input.targetId,
        input.relationType,
        confidence,
        input.sourceMemoryId ?? null,
        input.sourceMessageId ?? null,
        validFrom,
        Date.now(),
      );
    return this.db.prepare('SELECT * FROM entity_edges WHERE id = ?').get(id) as EntityEdge;
  }

  /**
   * Retract an edge at `at` by setting `valid_to`. The row is kept: the
   * retraction itself is part of the history.
   *
   * @returns true when an open edge was retracted.
   */
  retractEdge(id: string, at: number = Date.now()): boolean {
    const result = this.db
      .prepare('UPDATE entity_edges SET valid_to = ? WHERE id = ? AND valid_to IS NULL')
      .run(at, id);
    return result.changes > 0;
  }

  /**
   * Traverse the graph from `entityId` up to `depth` hops (default 1).
   *
   * A single recursive CTE walks the edges; `UNION` (not `UNION ALL`) drops
   * repeated (edge, depth) rows and the `walk.depth < @depth` bound stops the
   * recursion, so a cycle A→B→A terminates instead of looping. Each neighbour
   * is reported once, at the shallowest depth that reaches it.
   */
  neighbors(entityId: string, options: NeighborsOptions = {}): EntityNeighbor[] {
    const depth = Math.max(1, Math.min(MAX_DEPTH, Math.floor(options.depth ?? 1)));
    const limit = Math.max(1, Math.floor(options.limit ?? 100));

    const params: Record<string, unknown> = {
      origin: entityId,
      depth,
      asOf: options.asOf ?? null,
      limit,
    };

    let relationFilter = '';
    const relationTypes = options.relationTypes?.filter((type) => type.length > 0) ?? [];
    if (relationTypes.length > 0) {
      const placeholders = relationTypes.map((_, index) => `@relation${index}`);
      relationTypes.forEach((type, index) => {
        params[`relation${index}`] = type;
      });
      relationFilter = ` AND e.relation_type IN (${placeholders.join(', ')})`;
    }

    // Temporal validity: open-ended edges are always valid, retracted ones only
    // up to valid_to, and an edge that starts after asOf was not true yet.
    const validFilter =
      ' AND (@asOf IS NULL OR ((e.valid_from IS NULL OR e.valid_from <= @asOf) ' +
      'AND (e.valid_to IS NULL OR e.valid_to > @asOf)))';

    const rows = this.db
      .prepare(
        `WITH RECURSIVE walk(edge_id, to_entity_id, depth) AS (
           SELECT e.id,
                  CASE WHEN e.source_entity_id = @origin THEN e.target_entity_id ELSE e.source_entity_id END,
                  1
           FROM entity_edges e
           WHERE (e.source_entity_id = @origin OR e.target_entity_id = @origin)
             ${validFilter}${relationFilter}
           UNION
           SELECT e.id,
                  CASE WHEN e.source_entity_id = walk.to_entity_id THEN e.target_entity_id ELSE e.source_entity_id END,
                  walk.depth + 1
           FROM entity_edges e
           JOIN walk ON e.source_entity_id = walk.to_entity_id OR e.target_entity_id = walk.to_entity_id
           WHERE walk.depth < @depth
             ${validFilter}${relationFilter}
         )
         SELECT walk.depth AS depth,
                walk.edge_id AS edge_id,
                e.relation_type AS relation_type,
                e.confidence AS confidence,
                ent.id AS id,
                ent.name AS name,
                ent.canonical_name AS canonical_name,
                ent.entity_type AS entity_type,
                ent.description AS description,
                ent.created_at AS created_at,
                ent.updated_at AS updated_at
         FROM walk
         JOIN entity_edges e ON e.id = walk.edge_id
         JOIN entities ent ON ent.id = walk.to_entity_id
         WHERE walk.to_entity_id <> @origin
         ORDER BY walk.depth, ent.canonical_name
         LIMIT @limit`,
      )
      .all(params) as Array<
      Entity & { depth: number; edge_id: string; relation_type: string; confidence: number }
    >;

    const seen = new Set<string>();
    const neighbors: EntityNeighbor[] = [];
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      neighbors.push({
        entity: {
          id: row.id,
          name: row.name,
          canonical_name: row.canonical_name,
          entity_type: row.entity_type,
          description: row.description,
          created_at: row.created_at,
          updated_at: row.updated_at,
        },
        depth: row.depth,
        edgeId: row.edge_id,
        relationType: row.relation_type,
        confidence: row.confidence,
      });
    }
    return neighbors;
  }

  /** Substring match over canonical names and aliases, exact matches first. */
  searchEntities(q: string, limit: number = 20): Entity[] {
    const canonical = canonicalizeEntityName(q);
    if (!canonical) return [];
    const pattern = `%${escapeLike(canonical)}%`;
    return this.db
      .prepare(
        `SELECT DISTINCT e.* FROM entities e
         LEFT JOIN entity_aliases a ON a.entity_id = e.id
         WHERE e.canonical_name LIKE @pattern ESCAPE '\\'
            OR a.alias LIKE @pattern ESCAPE '\\'
         ORDER BY CASE WHEN e.canonical_name = @exact THEN 0 ELSE 1 END,
                  length(e.canonical_name),
                  e.canonical_name
         LIMIT @limit`,
      )
      .all({ pattern, exact: canonical, limit: Math.max(1, Math.floor(limit)) }) as Entity[];
  }

  entityCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS cnt FROM entities').get() as { cnt: number };
    return row.cnt;
  }
}
