// ---------------------------------------------------------------------------
// entity_query — read the knowledge graph: an entity's neighbourhood, its
// relation-types, and "what was true at asOf"
// ---------------------------------------------------------------------------

import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { textResult, errorResult } from '../../platform/tool-result.js';
import { zodToTypeBox } from '../../tool-adapter.js';
import {
  parseGraphAsOf,
  queryEntityGraph,
  type EntityGraphQuery,
} from '../../../graph/graph-query.js';

export const entityQueryToolCapability: ToolCapabilityDescriptor = {
  category: 'memory',
  readOnly: true,
  readsFiles: false,
  writesFiles: false,
  usesShell: false,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'none',
  approvalDefault: 'none',
};

/**
 * Two hops, not the WebUI's three: a 3-hop neighbourhood is mostly nodes the
 * question never asked about, and every one of them costs tokens.
 */
const MAX_ENTITY_QUERY_DEPTH = 2;
const DEFAULT_ENTITY_QUERY_LIMIT = 40;
/** Hard cap — a whole-graph dump is not an answer to "what is X connected to". */
const MAX_ENTITY_QUERY_LIMIT = 100;

export const entityQueryParams = z.object({
  name: z.string().min(1).describe('Entity to start from: its name, canonical name, alias or id.'),
  depth: z
    .number()
    .int()
    .min(1)
    .max(MAX_ENTITY_QUERY_DEPTH)
    .optional()
    .describe('Hops to walk: 1 (default) or 2.'),
  relationTypes: z
    .array(z.string().min(1))
    .optional()
    .describe('Only traverse these relation types, e.g. ["USES","DEPENDS_ON"]. Case-sensitive.'),
  asOf: z
    .union([z.number(), z.string()])
    .optional()
    .describe(
      'Point in time (epoch ms or ISO-8601). Edges not valid then — not yet true, or already retracted — are omitted.',
    ),
  includeMentions: z
    .boolean()
    .optional()
    .describe(
      'Also list names that co-occur with this entity in the same memories, in a separate `mentions` array. They are never edges.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_ENTITY_QUERY_LIMIT)
    .optional()
    .describe(
      `Maximum neighbours, edges and mentions. Default ${DEFAULT_ENTITY_QUERY_LIMIT}, max ${MAX_ENTITY_QUERY_LIMIT}.`,
    ),
});

export type EntityQueryArgs = z.infer<typeof entityQueryParams>;

/**
 * The model-facing payload: names instead of ids, no degree, no canonical keys.
 *
 * Every edge names both endpoints as strings, so a reader never has to resolve
 * an id against the node list; the queried entity is reported once as `entity`
 * and the neighbours are `nodes`.
 */
interface EntityPageRow {
  slug: string;
  page_type: string;
  title: string;
}

/**
 * The curated pages written about this entity (migration-v21's `entity_id`).
 *
 * This is what makes the two graphs one answer: `entity_query` used to report
 * what memories asserted about a name and nothing about what a human or agent
 * had written about it. Absent on a database that has no knowledge layer, in
 * which case the key is simply omitted rather than reporting an empty list as
 * if there were none.
 */
function pagesAbout(db: Database.Database, entityId: string): EntityPageRow[] | null {
  const table = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_pages'`)
    .get() as { name: string } | undefined;
  if (!table) return null;
  const column = (db.pragma('table_info(knowledge_pages)') as Array<{ name: string }>).some(
    (row) => row.name === 'entity_id',
  );
  if (!column) return null;
  return db
    .prepare(
      `SELECT slug, page_type, title FROM knowledge_pages
        WHERE entity_id = ? AND status = 'active'
        ORDER BY updated_at DESC, id ASC LIMIT 5`,
    )
    .all(entityId) as EntityPageRow[];
}

function toPayload(
  query: EntityGraphQuery,
  includeMentions: boolean,
  pages: EntityPageRow[] | null,
): Record<string, unknown> {
  const nameById = new Map<string, string>([[query.origin.id, query.origin.name]]);
  for (const node of query.nodes) nameById.set(node.id, node.name);
  const nameOf = (id: string): string => nameById.get(id) ?? id;

  return {
    entity: { name: query.origin.name, type: query.origin.entity_type },
    nodes: query.nodes.map((node) => ({ name: node.name, type: node.entity_type })),
    edges: query.edges.map((edge) => ({
      subject: nameOf(edge.source),
      relation: edge.relation_type,
      object: nameOf(edge.target),
      valid_from: edge.valid_from ?? null,
      valid_to: edge.valid_to ?? null,
      confidence: edge.confidence,
    })),
    ...(includeMentions ? { mentions: query.mentions } : {}),
    ...(pages === null
      ? {}
      : {
          pages: pages.map((page) => ({
            page_type: page.page_type,
            slug: page.slug,
            title: page.title,
          })),
        }),
    truncated: query.truncated,
  };
}

export function createEntityQueryToolDefinition(options: {
  db: Database.Database;
}): ToolDefinition<EntityQueryArgs> {
  return {
    name: 'entity_query',
    label: 'Entity Query',
    description:
      'Query the knowledge graph: one entity’s neighbourhood as edges (subject, relation, object) with their validity window and confidence, plus the curated pages written about it (`pages`). Use it for "what is X connected to", "what did X depend on in June" (asOf), or to read one relation type. Edges are statements a producer asserted; co-occurrence ("mentioned together") is never a neighbour or an edge — includeMentions lists it separately. The gates judge adjacency, not word order, so treat a direction the source text does not state as unverified. `truncated: true` means a cap cut the answer.',
    category: 'memory',
    parametersSchema: zodToTypeBox(entityQueryParams),
    capability: entityQueryToolCapability,
    deferrable: true,
    execute: async (args) => {
      const parsed = entityQueryParams.safeParse(args);
      if (!parsed.success) {
        return errorResult(
          `Invalid arguments: ${parsed.error.issues.map((issue) => issue.message).join(', ')}`,
        );
      }

      const includeMentions = parsed.data.includeMentions === true;
      const query = queryEntityGraph(options.db, parsed.data.name, {
        depth: parsed.data.depth,
        asOf: parseGraphAsOf(parsed.data.asOf),
        relationTypes: parsed.data.relationTypes,
        limit: parsed.data.limit,
        includeMentions,
      });

      if (!query) {
        // The graph is a derived view: on a fresh install it is empty until the
        // first sync, and "no such entity" is the ordinary answer there.
        return errorResult(
          `No entity named "${parsed.data.name}" in the knowledge graph. The graph is built by the background sync — an empty graph is normal on a fresh install.`,
        );
      }

      return textResult(
        JSON.stringify(toPayload(query, includeMentions, pagesAbout(options.db, query.origin.id))),
        {
          entity: query.origin.name,
          nodes: query.nodes.length,
          edges: query.edges.length,
          mentions: query.mentions.length,
          truncated: query.truncated,
        },
      );
    },
  };
}
