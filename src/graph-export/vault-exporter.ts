/**
 * One-way projection of the memory database into an Obsidian vault.
 *
 * The database is the source of truth; the vault is disposable output. That
 * split is enforced here, not by convention:
 *
 *   - every read goes through an existing handle (the CLI opens it read-only),
 *   - only `index.md`, `pages/`, `entities/`, `memories/` and `sessions/` are
 *     written, so `manual/**` (hand-written notes) can never be overwritten or
 *     deleted,
 *   - `.oma-state.json` remembers what this exporter generated last run, so a
 *     note that no longer has a backing row is deleted while anything else in
 *     the vault is left alone,
 *   - output is deterministic: sorted queries, fixed frontmatter key order, and
 *     timestamps taken from rows rather than the clock. Two runs against an
 *     unchanged database produce byte-identical notes, which is what makes the
 *     vault safe to put in git and cheap to re-run on a schedule.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  formatConfidence,
  formatTimestamp,
  frontmatterBlock,
  singleLine,
  wikilink,
  wikilinkTarget,
} from './format.js';
import {
  parseAliases,
  readEntityGraph,
  type EntityGraph,
  type GraphEntity,
} from './entity-tables.js';
import { dedupeStrings } from './collections.js';
import { hasTable, pickColumn, tableColumns } from './sqlite-schema.js';
import { isGeneratedNotePath, safeFileStem, safeJoin } from './slug.js';
import { isPageType } from '../memory/knowledge/types.js';

/** Vault-relative path of the generated-file state. Root-level and dot-prefixed so Obsidian ignores it. */
export const VAULT_STATE_FILE = '.oma-state.json';

/** Reserved for hand-written notes; never written, never deleted. */
export const MANUAL_DIR = 'manual';

/** Reported to the operator when the entity graph cannot be projected. */
export const ENTITY_TABLES_ABSENT_NOTICE = 'entity tables not present — skipping';

const STATE_VERSION = 1;
const INDEX_MEMORY_LINK_LIMIT = 50;

export interface ExportVaultOptions {
  db: Database.Database;
  outDir: string;
  /** Compute the plan and report it without touching the filesystem. */
  dryRun?: boolean;
  /** Log one line per written / unchanged / deleted note. */
  verbose?: boolean;
}

export interface ExportVaultResult {
  outDir: string;
  /** Vault-relative POSIX paths, sorted. */
  written: string[];
  unchanged: string[];
  deleted: string[];
  dryRun: boolean;
  entityTablesPresent: boolean;
  /** Operator-facing messages (e.g. why the entity part was skipped). */
  notes: string[];
}

interface MemoryRecord {
  id: string;
  kind: string | null;
  scope: string | null;
  scopeKey: string | null;
  status: string | null;
  confidence: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  sourceChannel: string | null;
  content: string;
}

interface MemoryEntityLink {
  memoryId: string;
  target: string;
  relation: string;
  confidence: number | null;
}

interface SessionRecord {
  id: string;
  chatId: string | null;
  userId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  episodes: { summary: string; createdAt: string | null }[];
}

/**
 * One `knowledge_pages` row, as the projection needs it.
 *
 * `pageType` stays a raw string rather than `PageType`: the column is a closed
 * set at the write boundary, but this exporter reads whatever an older or
 * hand-edited database holds, and it must not throw on a value the memory layer
 * would refuse.
 */
interface KnowledgePageRecord {
  id: string;
  pageType: string | null;
  slug: string;
  title: string;
  status: string | null;
  version: number | null;
  tags: string[];
  aliases: string[];
  /** Citations as `kind:id`, sorted — the page's provenance, not a payload. */
  sources: string[];
  content: string;
}

interface GeneratedNote {
  /** Vault-relative POSIX path. */
  path: string;
  content: string;
}

interface GeneratedPage {
  page: KnowledgePageRecord;
  /** File stem: what an Obsidian `[[wikilink]]` has to name to reach this note. */
  stem: string;
  /** Vault-relative POSIX path. */
  path: string;
}

type Row = Record<string, unknown>;

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

/**
 * Read active memories. Statuses other than `active` (superseded / deleted) are
 * the database's own tombstones and are not knowledge, so they stay out of the
 * vault the same way they stay out of retrieval.
 */
function readMemories(db: Database.Database): MemoryRecord[] {
  if (!hasTable(db, 'memories')) return [];
  const columns = tableColumns(db, 'memories');
  const statusColumn = pickColumn(columns, ['status']);
  const kindColumn = pickColumn(columns, ['kind']);
  const scopeColumn = pickColumn(columns, ['scope']);
  const scopeKeyColumn = pickColumn(columns, ['scope_key', 'scopeKey']);
  const confidenceColumn = pickColumn(columns, ['confidence']);
  const createdAtColumn = pickColumn(columns, ['created_at', 'createdAt']);
  const updatedAtColumn = pickColumn(columns, ['updated_at', 'updatedAt']);
  const sourceChannelColumn = pickColumn(columns, ['source_channel', 'sourceChannel']);

  const where = statusColumn ? ` WHERE "${statusColumn}" = 'active'` : '';
  const rows = db.prepare(`SELECT * FROM memories${where} ORDER BY id`).all() as Row[];

  const memories: MemoryRecord[] = [];
  for (const row of rows) {
    const id = asText(row.id);
    const content = asText(row.content);
    if (!id || content === null) continue;
    const raw = (column: string | null): unknown =>
      column ? (row[column] ?? row[column.toLowerCase()]) : null;
    memories.push({
      id,
      kind: asText(raw(kindColumn)),
      scope: asText(raw(scopeColumn)),
      scopeKey: asText(raw(scopeKeyColumn)),
      status: asText(raw(statusColumn)),
      confidence: asNumber(raw(confidenceColumn)),
      createdAt: formatTimestamp(raw(createdAtColumn)),
      updatedAt: formatTimestamp(raw(updatedAtColumn)),
      sourceChannel: asText(raw(sourceChannelColumn)),
      content,
    });
  }
  return memories;
}

/**
 * Memory → entity links. `memory_links.target_entity` holds the entity *name*
 * (not an id), which is also how the entity graph is joined back to memories
 * below — that join predates the `entities` table and keeps working when the
 * entity tables are absent.
 */
function readMemoryEntityLinks(db: Database.Database): Map<string, MemoryEntityLink[]> {
  const byMemory = new Map<string, MemoryEntityLink[]>();
  if (!hasTable(db, 'memory_links')) return byMemory;
  const columns = tableColumns(db, 'memory_links');
  const sourceColumn = pickColumn(columns, ['source_memory_id', 'sourceMemoryId']);
  const targetColumn = pickColumn(columns, ['target_entity', 'targetEntity']);
  if (!sourceColumn || !targetColumn) return byMemory;
  const relationColumn = pickColumn(columns, ['relation_type', 'relationType']);
  const confidenceColumn = pickColumn(columns, ['confidence']);

  const rows = db
    .prepare(
      `SELECT "${sourceColumn}" AS source_id, "${targetColumn}" AS target,
              ${relationColumn ? `"${relationColumn}"` : 'NULL'} AS relation,
              ${confidenceColumn ? `"${confidenceColumn}"` : 'NULL'} AS confidence
       FROM memory_links ORDER BY source_id, target`,
    )
    .all() as Row[];

  for (const row of rows) {
    const memoryId = asText(row.source_id);
    const target = asText(row.target);
    if (!memoryId || !target) continue;
    const links = byMemory.get(memoryId) ?? [];
    links.push({
      memoryId,
      target,
      relation: asText(row.relation) ?? 'mentions',
      confidence: asNumber(row.confidence),
    });
    byMemory.set(memoryId, links);
  }
  return byMemory;
}

/**
 * Session summaries, projected only when the summary rows already exist
 * (`episodes`). Sessions without an episode would be an empty note per chat
 * turn, so they are skipped rather than generated.
 */
function readSessions(db: Database.Database): SessionRecord[] {
  if (!hasTable(db, 'sessions') || !hasTable(db, 'episodes')) return [];
  const sessionColumns = tableColumns(db, 'sessions');
  const episodeColumns = tableColumns(db, 'episodes');
  const sessionId = pickColumn(sessionColumns, ['id']);
  const episodeSessionId = pickColumn(episodeColumns, ['session_id', 'sessionId']);
  const summaryColumn = pickColumn(episodeColumns, ['summary', 'content']);
  if (!sessionId || !episodeSessionId || !summaryColumn) return [];

  const chatColumn = pickColumn(sessionColumns, ['chat_id', 'chatId']);
  const userColumn = pickColumn(sessionColumns, ['user_id', 'userId']);
  const createdColumn = pickColumn(sessionColumns, ['created_at', 'createdAt']);
  const updatedColumn = pickColumn(sessionColumns, ['updated_at', 'updatedAt']);
  const episodeCreatedColumn = pickColumn(episodeColumns, ['created_at', 'createdAt']);

  const rows = db
    .prepare(
      `SELECT s."${sessionId}" AS id,
              ${chatColumn ? `s."${chatColumn}"` : 'NULL'} AS chat_id,
              ${userColumn ? `s."${userColumn}"` : 'NULL'} AS user_id,
              ${createdColumn ? `s."${createdColumn}"` : 'NULL'} AS created_at,
              ${updatedColumn ? `s."${updatedColumn}"` : 'NULL'} AS updated_at,
              e."${summaryColumn}" AS summary,
              ${episodeCreatedColumn ? `e."${episodeCreatedColumn}"` : 'NULL'} AS episode_created_at
       FROM sessions s
       JOIN episodes e ON e."${episodeSessionId}" = s."${sessionId}"
       ORDER BY s."${sessionId}", episode_created_at`,
    )
    .all() as Row[];

  const sessions = new Map<string, SessionRecord>();
  for (const row of rows) {
    const id = asText(row.id);
    const summary = asText(row.summary);
    if (!id || !summary) continue;
    const session = sessions.get(id) ?? {
      id,
      chatId: asText(row.chat_id),
      userId: asText(row.user_id),
      createdAt: formatTimestamp(row.created_at),
      updatedAt: formatTimestamp(row.updated_at),
      episodes: [],
    };
    session.episodes.push({ summary, createdAt: formatTimestamp(row.episode_created_at) });
    sessions.set(id, session);
  }
  return [...sessions.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Citations per page, as `kind:id`, in the order the primary key gives.
 *
 * Read separately from the pages so an install with pages but no sources table
 * (never produced by a migration, but possible in a hand-restored database)
 * still exports the pages.
 */
function readKnowledgePageSources(db: Database.Database): Map<string, string[]> {
  const byPage = new Map<string, string[]>();
  if (!hasTable(db, 'knowledge_sources')) return byPage;
  const rows = db
    .prepare(
      `SELECT page_id, source_kind, source_id FROM knowledge_sources
        ORDER BY page_id, source_kind, source_id`,
    )
    .all() as Row[];
  for (const row of rows) {
    const pageId = asText(row.page_id);
    const kind = asText(row.source_kind);
    const sourceId = asText(row.source_id);
    if (!pageId || !kind || !sourceId) continue;
    const sources = byPage.get(pageId) ?? [];
    sources.push(`${kind}:${sourceId}`);
    byPage.set(pageId, sources);
  }
  return byPage;
}

/**
 * Active knowledge pages, in `(page_type, slug)` order.
 *
 * `status = 'active'` is the knowledge layer's hard read filter (search, get,
 * injection, link resolution), so the vault uses the same one: a `pending` page
 * is unreviewed curation and an `archived` page is history, and exporting either
 * would let the vault show what the agent itself will not answer from.
 */
function readKnowledgePages(db: Database.Database): KnowledgePageRecord[] {
  if (!hasTable(db, 'knowledge_pages')) return [];
  const sourcesByPage = readKnowledgePageSources(db);
  const rows = db
    .prepare(
      `SELECT * FROM knowledge_pages WHERE status = 'active'
        ORDER BY page_type, slug, id`,
    )
    .all() as Row[];

  const pages: KnowledgePageRecord[] = [];
  for (const row of rows) {
    const id = asText(row.id);
    const slug = asText(row.slug);
    // A page body is markdown, stored verbatim: only an unreadable or empty one
    // is skipped, and `trim()` here is the test, not the projection.
    const content = typeof row.content === 'string' ? row.content : '';
    if (!id || !slug || !content.trim()) continue;
    pages.push({
      id,
      pageType: asText(row.page_type),
      slug,
      title: asText(row.title) ?? slug,
      status: asText(row.status),
      version: asNumber(row.version),
      tags: dedupeStrings(parseAliases(row.tags)),
      aliases: dedupeStrings(parseAliases(row.aliases)),
      sources: sourcesByPage.get(id) ?? [],
      content,
    });
  }
  return pages;
}

/**
 * Assign one file stem per key, disambiguating keys that slugify to the same
 * text (`Alice Smith` vs `alice-smith`) with a hash of the raw key. The mapping
 * depends only on the data, so it is stable across runs.
 */
function assignStems(items: { key: string; raw: string }[]): Map<string, string> {
  const stems = new Map<string, string>();
  const byStem = new Map<string, string[]>();
  for (const item of items) {
    const stem = safeFileStem(item.raw);
    stems.set(item.key, stem);
    const group = byStem.get(stem) ?? [];
    group.push(item.key);
    byStem.set(stem, group);
  }
  for (const [stem, keys] of byStem) {
    if (keys.length < 2) continue;
    for (const key of keys) {
      const raw = items.find((item) => item.key === key)?.raw ?? key;
      const suffix = createHash('sha256').update(raw).digest('hex').slice(0, 8);
      stems.set(key, `${stem}-${suffix}`);
    }
  }
  return stems;
}

function shortDate(timestamp: string | null): string | null {
  return timestamp ? timestamp.slice(0, 10) : null;
}

/**
 * Vault path and stem of every page note.
 *
 * `pages/<page_type>/<slug>.md`, or `pages/<slug>.md` when the row's `page_type`
 * is outside the closed set — there is no directory to file such a row under
 * that would not invent a type for it. The stem is the slug with no prefix,
 * because the page body addresses its neighbours as `[[slug]]`: Obsidian
 * resolves a bare link by file name (shortest path), so a prefixed stem would
 * turn every existing wikilink into a dead one.
 *
 * `safeFileStem` differs from the slug only for the names a filesystem refuses
 * outright (Windows `CON`, `NUL`, …): such a page cannot be addressed as
 * `[[con]]` on Windows either, and one failed write would abort the export.
 */
function assignPageFiles(pages: readonly KnowledgePageRecord[]): GeneratedPage[] {
  const taken = new Set<string>();
  const files: GeneratedPage[] = [];
  for (const page of pages) {
    const dir = isPageType(page.pageType) ? `pages/${page.pageType}` : 'pages';
    let stem = safeFileStem(page.slug);
    let notePath = `${dir}/${stem}.md`;
    if (taken.has(notePath)) {
      // Only a corrupt `page_type` can get here: two untitled-by-type rows that
      // share a slug. The id keeps them apart, deterministically.
      const suffix = createHash('sha256').update(page.id).digest('hex').slice(0, 8);
      stem = `${stem}-${suffix}`;
      notePath = `${dir}/${stem}.md`;
    }
    taken.add(notePath);
    files.push({ page, stem, path: notePath });
  }
  return files;
}

function confidenceSuffix(confidence: number | null): string {
  return confidence === null ? '' : ` (confidence ${formatConfidence(confidence)})`;
}

function relationLines(
  relations: { other: string; relation: string; confidence: number | null }[],
): string[] {
  return relations.map(
    (relation) =>
      `- ${wikilink(relation.other)} — ${relation.relation}${confidenceSuffix(relation.confidence)}`,
  );
}

function renderEntityNote(
  entity: GraphEntity,
  graph: EntityGraph,
  memories: MemoryRecord[],
  memoryStems: Map<string, string>,
  memoryLinksById: Map<string, MemoryEntityLink[]>,
): string {
  const nameById = new Map(graph.entities.map((item) => [item.id, item.name]));

  const outgoing = graph.relations
    .filter((relation) => relation.fromId === entity.id)
    .map((relation) => ({
      other: nameById.get(relation.toId) ?? relation.toId,
      relation: relation.relation,
      confidence: relation.confidence,
    }))
    .sort(
      (a, b) =>
        a.other.localeCompare(b.other) ||
        a.relation.localeCompare(b.relation) ||
        (a.confidence ?? -1) - (b.confidence ?? -1),
    );

  const incoming = graph.relations
    .filter((relation) => relation.toId === entity.id)
    .map((relation) => ({
      other: nameById.get(relation.fromId) ?? relation.fromId,
      relation: relation.relation,
      confidence: relation.confidence,
    }))
    .sort(
      (a, b) =>
        a.other.localeCompare(b.other) ||
        a.relation.localeCompare(b.relation) ||
        (a.confidence ?? -1) - (b.confidence ?? -1),
    );

  const sourceMemories = memories
    .filter((memory) =>
      (memoryLinksById.get(memory.id) ?? []).some(
        (link) => link.target.toLowerCase() === entity.name.toLowerCase(),
      ),
    )
    .sort(
      (a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.id.localeCompare(b.id),
    );

  const aliases = dedupeStrings([entity.name, ...entity.aliases]);
  const frontmatterData: Record<string, unknown> = { id: entity.id };
  if (entity.entityType) frontmatterData.entity_type = entity.entityType;
  frontmatterData.aliases = aliases; // the canonical name is an alias so `[[Entity Name]]` resolves
  if (entity.updatedAt) frontmatterData.updated_at = entity.updatedAt;

  const lines: string[] = [frontmatterBlock(frontmatterData), `# ${singleLine(entity.name)}`, ''];
  lines.push(entity.description ?? '_No description recorded._', '');

  if (outgoing.length > 0 || incoming.length > 0) {
    lines.push('## Relations', '');
    if (outgoing.length > 0) lines.push('### Outgoing', '', ...relationLines(outgoing), '');
    if (incoming.length > 0) lines.push('### Incoming', '', ...relationLines(incoming), '');
  }

  if (sourceMemories.length > 0) {
    lines.push('## Source memories', '');
    for (const memory of sourceMemories) {
      const stem = memoryStems.get(memory.id);
      const date = shortDate(memory.updatedAt ?? memory.createdAt);
      const suffix = date ? ` — ${date}` : '';
      lines.push(`- ${wikilink(`memories/${stem}`, memoryTitle(memory))}${suffix}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function renderMemoryNote(
  memory: MemoryRecord,
  entityTablesPresent: boolean,
  entityByName: Map<string, GraphEntity>,
  links: MemoryEntityLink[],
): string {
  const frontmatterData: Record<string, unknown> = { id: memory.id };
  if (memory.kind) frontmatterData.kind = memory.kind;
  if (memory.scope) frontmatterData.scope = memory.scope;
  if (memory.scopeKey) frontmatterData.scope_key = memory.scopeKey;
  if (memory.status) frontmatterData.status = memory.status;
  if (memory.confidence !== null) frontmatterData.confidence = memory.confidence;
  if (memory.createdAt) frontmatterData.created_at = memory.createdAt;
  if (memory.updatedAt) frontmatterData.updated_at = memory.updatedAt;
  if (memory.sourceChannel) frontmatterData.source_channel = memory.sourceChannel;

  const title = memoryTitle(memory);
  const lines: string[] = [frontmatterBlock(frontmatterData), `# ${title}`, '', memory.content, ''];

  if (links.length > 0) {
    lines.push('## Entities', '');
    for (const link of links) {
      const label = entityTablesPresent
        ? wikilink(entityByName.get(link.target.toLowerCase())?.name ?? link.target)
        : wikilinkTarget(link.target);
      lines.push(`- ${label} — ${link.relation}${confidenceSuffix(link.confidence)}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function memoryTitle(memory: MemoryRecord): string {
  const firstLine =
    memory.content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  const cleaned = wikilinkTarget(firstLine);
  if (!cleaned) return `Memory ${memory.id}`;
  return cleaned.length > 80 ? `${cleaned.slice(0, 77)}...` : cleaned;
}

/**
 * One knowledge-page note: YAML frontmatter, then the stored body verbatim.
 *
 * No heading is synthesised and no markdown is re-rendered — the body is the
 * authored text (curated pages deliberately carry no top-level heading, the
 * title is stored separately), so the vault stays a projection rather than a
 * second author. Key order is fixed by the object literal: title, page_type,
 * status, version, then the lists, which keeps two runs byte-identical.
 */
function renderPageNote(page: KnowledgePageRecord): string {
  const frontmatterData: Record<string, unknown> = { title: page.title };
  if (page.pageType) frontmatterData.page_type = page.pageType;
  if (page.status) frontmatterData.status = page.status;
  if (page.version !== null) frontmatterData.version = page.version;
  if (page.tags.length > 0) frontmatterData.tags = page.tags;
  if (page.aliases.length > 0) frontmatterData.aliases = page.aliases;
  if (page.sources.length > 0) frontmatterData.sources = page.sources;

  const body = page.content.replace(/\n+$/, '');
  return `${frontmatterBlock(frontmatterData)}\n${body}\n`;
}

function renderSessionNote(session: SessionRecord): string {
  const frontmatterData: Record<string, unknown> = { id: session.id };
  if (session.chatId) frontmatterData.chat_id = session.chatId;
  if (session.userId) frontmatterData.user_id = session.userId;
  if (session.createdAt) frontmatterData.created_at = session.createdAt;
  if (session.updatedAt) frontmatterData.updated_at = session.updatedAt;

  const lines: string[] = [frontmatterBlock(frontmatterData), `# Session ${session.id}`, ''];
  for (const episode of session.episodes) {
    const date = shortDate(episode.createdAt);
    lines.push(`## ${date ?? 'Summary'}`, '', episode.summary, '');
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function renderIndex(input: {
  entities: GraphEntity[];
  relations: EntityGraph['relations'];
  memories: MemoryRecord[];
  sessions: SessionRecord[];
  pages: GeneratedPage[];
  entityTablesPresent: boolean;
  memoryStems: Map<string, string>;
}): string {
  const lines: string[] = [
    frontmatterBlock({ title: 'OhMyAgent vault' }),
    '# OhMyAgent vault',
    '',
    'This vault is a **projection** of the agent database: `pnpm graph:export`',
    'rewrites `index.md`, `pages/`, `entities/`, `memories/` and `sessions/` in one',
    'direction. Knowledge is authored in the database (through the agent), never in',
    'these notes — edits to a generated note are lost on the next export.',
    '',
    `Notes under \`${MANUAL_DIR}/\` are hand-written and are never overwritten or deleted.`,
    '',
    '## Counts',
    '',
    '| Item | Count |',
    '| --- | --- |',
    `| Entities | ${input.entities.length} |`,
    `| Relations | ${input.relations.length} |`,
    `| Memories | ${input.memories.length} |`,
    `| Sessions | ${input.sessions.length} |`,
    `| Pages | ${input.pages.length} |`,
    '',
    'Only `active` memories and `active` knowledge pages are projected; superseded',
    'memories and pending or archived pages stay in the database.',
    '',
  ];

  if (!input.entityTablesPresent) {
    lines.push(
      '> Entity tables are not present in this database, so entity notes are not generated.',
      '',
    );
  }

  if (input.entities.length > 0) {
    lines.push('## Entities', '');
    for (const entity of input.entities) {
      const suffix = entity.entityType ? ` — ${entity.entityType}` : '';
      lines.push(`- ${wikilink(entity.name)}${suffix}`);
    }
    lines.push('');
  }

  if (input.pages.length > 0) {
    lines.push('## Pages', '');
    for (const entry of input.pages) {
      const suffix = entry.page.pageType ? ` — ${entry.page.pageType}` : '';
      lines.push(`- ${wikilink(entry.stem, entry.page.title)}${suffix}`);
    }
    lines.push('');
  }

  if (input.memories.length > 0) {
    lines.push('## Recent memories', '');
    const recent = [...input.memories]
      .sort(
        (a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.id.localeCompare(b.id),
      )
      .slice(0, INDEX_MEMORY_LINK_LIMIT);
    for (const memory of recent) {
      const date = shortDate(memory.updatedAt ?? memory.createdAt);
      const kind = memory.kind ?? 'memory';
      const suffix = date ? ` — ${kind}, ${date}` : ` — ${kind}`;
      lines.push(
        `- ${wikilink(`memories/${input.memoryStems.get(memory.id)}`, memoryTitle(memory))}${suffix}`,
      );
    }
    if (input.memories.length > recent.length) {
      lines.push('', `_${input.memories.length - recent.length} older memories are not listed._`);
    }
    lines.push('');
  }

  if (input.sessions.length > 0) {
    lines.push('## Sessions', '');
    for (const session of input.sessions) {
      const date = shortDate(session.updatedAt ?? session.createdAt);
      const suffix = date ? ` — ${date}` : '';
      lines.push(`- ${wikilink(`sessions/${safeFileStem(session.id)}`, session.id)}${suffix}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

function writeNote(absolutePath: string, content: string): void {
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.tmp`;
  fs.writeFileSync(temporaryPath, content, 'utf8');
  fs.renameSync(temporaryPath, absolutePath);
}

function readGeneratedState(statePath: string): string[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return [];
    const files = (parsed as { files?: unknown }).files;
    if (!Array.isArray(files)) return [];
    return files
      .filter((entry): entry is string => typeof entry === 'string')
      .map(normalizeRelativePath)
      .filter(isGeneratedNotePath);
  } catch {
    // Missing or corrupt state pins nothing, so nothing is deleted this run.
    return [];
  }
}

function renderState(files: string[]): string {
  return `${JSON.stringify({ version: STATE_VERSION, files: [...files].sort() }, null, 2)}\n`;
}

/**
 * Project the database into `outDir`. Read-only with respect to the database;
 * idempotent with respect to the vault.
 */
export function exportVault(options: ExportVaultOptions): ExportVaultResult {
  const dryRun = options.dryRun ?? false;
  const outDir = path.resolve(options.outDir);
  const notes: string[] = [];

  const memories = readMemories(options.db);
  const memoryLinksById = readMemoryEntityLinks(options.db);
  const sessions = readSessions(options.db);
  const knowledgePages = assignPageFiles(readKnowledgePages(options.db));
  const entityRead = readEntityGraph(options.db);
  const entityTablesPresent = entityRead.present;
  const graph = entityRead.graph;
  if (!entityTablesPresent) notes.push(ENTITY_TABLES_ABSENT_NOTICE);

  const memoryStems = assignStems(memories.map((memory) => ({ key: memory.id, raw: memory.id })));
  const entityStems = assignStems(
    graph.entities.map((entity) => ({ key: entity.id, raw: entity.name })),
  );
  const entityByName = new Map(graph.entities.map((entity) => [entity.name.toLowerCase(), entity]));

  const generated: GeneratedNote[] = [];

  for (const entry of knowledgePages) {
    generated.push({ path: entry.path, content: renderPageNote(entry.page) });
  }

  for (const entity of graph.entities) {
    generated.push({
      path: `entities/${entityStems.get(entity.id)}.md`,
      content: renderEntityNote(entity, graph, memories, memoryStems, memoryLinksById),
    });
  }

  for (const memory of memories) {
    generated.push({
      path: `memories/${memoryStems.get(memory.id)}.md`,
      content: renderMemoryNote(
        memory,
        entityTablesPresent,
        entityByName,
        memoryLinksById.get(memory.id) ?? [],
      ),
    });
  }

  for (const session of sessions) {
    generated.push({
      path: `sessions/${safeFileStem(session.id)}.md`,
      content: renderSessionNote(session),
    });
  }

  generated.push({
    path: 'index.md',
    content: renderIndex({
      entities: graph.entities,
      relations: graph.relations,
      memories,
      sessions,
      pages: knowledgePages,
      entityTablesPresent,
      memoryStems,
    }),
  });

  generated.sort((a, b) => a.path.localeCompare(b.path));

  const written: string[] = [];
  const unchanged: string[] = [];
  const deleted: string[] = [];

  if (!dryRun) fs.mkdirSync(outDir, { recursive: true });

  for (const note of generated) {
    if (!isGeneratedNotePath(note.path)) {
      throw new Error(`refusing to write a path outside the generated namespace: ${note.path}`);
    }
    const absolutePath = safeJoin(outDir, ...note.path.split('/'));
    const existing = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : null;
    if (existing === note.content) {
      unchanged.push(note.path);
      continue;
    }
    if (!dryRun) writeNote(absolutePath, note.content);
    written.push(note.path);
  }

  // Stale generated notes: whatever the previous run recorded and this run did
  // not produce. `manual/**` and any path outside the generated namespace are
  // never candidates, even if a hand-edited state file lists them.
  const statePath = safeJoin(outDir, VAULT_STATE_FILE);
  const currentPaths = new Set(generated.map((note) => note.path));
  const previousPaths = readGeneratedState(statePath);
  for (const stalePath of previousPaths) {
    if (currentPaths.has(stalePath)) continue;
    if (!isGeneratedNotePath(stalePath)) continue;
    const absolutePath = safeJoin(outDir, ...stalePath.split('/'));
    if (!fs.existsSync(absolutePath)) continue;
    if (!dryRun) fs.rmSync(absolutePath, { force: true });
    deleted.push(stalePath);
  }

  written.sort();
  unchanged.sort();
  deleted.sort();

  if (!dryRun) {
    const stateContent = renderState([...currentPaths]);
    const existingState = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : null;
    if (existingState !== stateContent) writeNote(statePath, stateContent);
  }

  if (options.verbose) {
    for (const notePath of written) console.log(`  write    ${notePath}`);
    for (const notePath of unchanged) console.log(`  same     ${notePath}`);
    for (const notePath of deleted) console.log(`  delete   ${notePath}`);
  }

  return { outDir, written, unchanged, deleted, dryRun, entityTablesPresent, notes };
}
