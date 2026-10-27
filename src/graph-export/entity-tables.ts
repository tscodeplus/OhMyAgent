/**
 * Reads the entity graph (`entities`, `entity_edges`, `entity_aliases`) out of
 * whatever shape those tables happen to have.
 *
 * The tables are owned by the memory layer and were introduced after this
 * exporter, so nothing here may assume a column name: each logical field is
 * resolved from a small candidate list against `PRAGMA table_info`. If the
 * tables are absent — an older database, or a deployment that has not run the
 * entity migration yet — the caller degrades to a memories-only vault instead of
 * crashing, and an unresolvable *required* column is treated the same way.
 */

import type Database from 'better-sqlite3';
import { formatTimestamp } from './format.js';
import { dedupeStrings } from './collections.js';
import { hasTable, pickColumn, tableColumns } from './sqlite-schema.js';

export const ENTITIES_TABLE = 'entities';
export const ENTITY_EDGES_TABLE = 'entity_edges';
export const ENTITY_ALIASES_TABLE = 'entity_aliases';

export interface GraphEntity {
  id: string;
  name: string;
  entityType: string | null;
  description: string | null;
  aliases: string[];
  updatedAt: string | null;
}

export interface GraphRelation {
  fromId: string;
  toId: string;
  relation: string;
  confidence: number | null;
}

export interface EntityGraph {
  entities: GraphEntity[];
  relations: GraphRelation[];
}

export interface EntityGraphRead {
  /** False when the entity tables are missing or too unlike the expected shape. */
  present: boolean;
  graph: EntityGraph;
}

interface EntityColumnCandidates {
  id: string[];
  name: string[];
  entityType: string[];
  description: string[];
  aliases: string[];
  updatedAt: string[];
}

const ENTITY_COLUMNS: EntityColumnCandidates = {
  id: ['id', 'entity_id', 'entityId'],
  name: ['name', 'canonical_name', 'canonicalName', 'title', 'label'],
  entityType: ['entity_type', 'entityType', 'type', 'kind', 'category'],
  description: ['description', 'summary', 'notes'],
  aliases: ['aliases', 'alias', 'alias_names'],
  updatedAt: ['updated_at', 'updatedAt', 'last_seen_at'],
};

const EDGE_COLUMNS = {
  from: ['source_entity_id', 'source_id', 'from_entity_id', 'from_id', 'entity_a_id', 'entity1_id'],
  to: ['target_entity_id', 'target_id', 'to_entity_id', 'to_id', 'entity_b_id', 'entity2_id'],
  relation: ['relation', 'relation_type', 'type', 'predicate', 'label'],
  confidence: ['confidence', 'weight', 'score', 'strength'],
};

const ALIAS_COLUMNS = {
  entityId: ['entity_id', 'entityId'],
  alias: ['alias', 'name', 'value'],
};

type Row = Record<string, unknown>;

function selectList(resolved: Record<string, string | null>): string {
  const parts: string[] = [];
  for (const [logical, column] of Object.entries(resolved)) {
    parts.push(column ? `"${column}" AS "${logical}"` : `NULL AS "${logical}"`);
  }
  return parts.join(', ');
}

/**
 * Aliases arrive as a JSON array, a comma/顿号 separated string, or a single
 * name depending on which writer produced them. All three are accepted.
 */
export function parseAliases(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => parseAliases(entry));
  }
  if (typeof value !== 'string') return [String(value).trim()].filter(Boolean);
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parseAliases(parsed);
    } catch {
      // Not JSON after all — fall through to the delimiter split.
    }
  }
  if (trimmed.startsWith('{')) {
    return []; // JSON object blob (e.g. raw metadata) — not an alias list.
  }
  return trimmed
    .split(/[,、;|]/)
    .map((part) => part.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

function readAliases(db: Database.Database, entityIds: Set<string>): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  if (entityIds.size === 0 || !hasTable(db, ENTITY_ALIASES_TABLE)) return byId;

  const aliasColumns = tableColumns(db, ENTITY_ALIASES_TABLE);
  const entityIdColumn = pickColumn(aliasColumns, ALIAS_COLUMNS.entityId);
  const aliasColumn = pickColumn(aliasColumns, ALIAS_COLUMNS.alias);
  if (!entityIdColumn || !aliasColumn) return byId;

  const rows = db
    .prepare(
      `SELECT "${entityIdColumn}" AS entity_id, "${aliasColumn}" AS alias FROM "${ENTITY_ALIASES_TABLE}"`,
    )
    .all() as Row[];
  for (const row of rows) {
    const entityId = asText(row.entity_id);
    const alias = asText(row.alias);
    if (!entityId || !alias || !entityIds.has(entityId)) continue;
    const list = byId.get(entityId) ?? [];
    list.push(alias);
    byId.set(entityId, list);
  }
  return byId;
}

/**
 * Load the entity graph. Never throws for a missing/mismatched schema: an
 * unreadable graph is reported as `present: false` so the caller can project
 * memories only.
 */
export function readEntityGraph(db: Database.Database): EntityGraphRead {
  if (!hasTable(db, ENTITIES_TABLE))
    return { present: false, graph: { entities: [], relations: [] } };

  const entityTableColumns = tableColumns(db, ENTITIES_TABLE);
  const entityIdColumn = pickColumn(entityTableColumns, ENTITY_COLUMNS.id);
  const entityNameColumn = pickColumn(entityTableColumns, ENTITY_COLUMNS.name);
  if (!entityIdColumn || !entityNameColumn)
    return { present: false, graph: { entities: [], relations: [] } };

  const entityTypeColumn = pickColumn(entityTableColumns, ENTITY_COLUMNS.entityType);
  const descriptionColumn = pickColumn(entityTableColumns, ENTITY_COLUMNS.description);
  const aliasesColumn = pickColumn(entityTableColumns, ENTITY_COLUMNS.aliases);
  const updatedAtColumn = pickColumn(entityTableColumns, ENTITY_COLUMNS.updatedAt);

  const entityRows = db
    .prepare(
      `SELECT ${selectList({
        id: entityIdColumn,
        name: entityNameColumn,
        entity_type: entityTypeColumn,
        description: descriptionColumn,
        aliases: aliasesColumn,
        updated_at: updatedAtColumn,
      })} FROM "${ENTITIES_TABLE}" ORDER BY "${entityIdColumn}"`,
    )
    .all() as Row[];

  const entities: GraphEntity[] = [];
  for (const row of entityRows) {
    const id = asText(row.id);
    const name = asText(row.name);
    if (!id || !name) continue;
    entities.push({
      id,
      name,
      entityType: asText(row.entity_type),
      description: asText(row.description),
      aliases: parseAliases(row.aliases),
      updatedAt: formatTimestamp(row.updated_at),
    });
  }

  const aliasesById = readAliases(db, new Set(entities.map((entity) => entity.id)));
  for (const entity of entities) {
    const extra = aliasesById.get(entity.id);
    if (extra) entity.aliases = dedupeStrings([...entity.aliases, ...extra]);
  }

  const relations = readRelations(db, new Set(entities.map((entity) => entity.id)));
  return { present: true, graph: { entities, relations } };
}

function readRelations(db: Database.Database, entityIds: Set<string>): GraphRelation[] {
  if (!hasTable(db, ENTITY_EDGES_TABLE)) return [];
  const columns = tableColumns(db, ENTITY_EDGES_TABLE);
  const fromColumn = pickColumn(columns, EDGE_COLUMNS.from);
  const toColumn = pickColumn(columns, EDGE_COLUMNS.to);
  if (!fromColumn || !toColumn) return [];

  const relationColumn = pickColumn(columns, EDGE_COLUMNS.relation);
  const confidenceColumn = pickColumn(columns, EDGE_COLUMNS.confidence);

  const rows = db
    .prepare(
      `SELECT ${selectList({
        from_id: fromColumn,
        to_id: toColumn,
        relation: relationColumn,
        confidence: confidenceColumn,
      })} FROM "${ENTITY_EDGES_TABLE}" ORDER BY "${fromColumn}", "${toColumn}"`,
    )
    .all() as Row[];

  const relations: GraphRelation[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const fromId = asText(row.from_id);
    const toId = asText(row.to_id);
    // Dangling edges would render a link to a note that is not in the vault.
    if (!fromId || !toId || !entityIds.has(fromId) || !entityIds.has(toId)) continue;
    const relation = asText(row.relation) ?? 'related_to';
    const confidence = asNumber(row.confidence);
    const key = `${fromId}\u0000${toId}\u0000${relation}\u0000${confidence ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    relations.push({ fromId, toId, relation, confidence });
  }
  return relations;
}
