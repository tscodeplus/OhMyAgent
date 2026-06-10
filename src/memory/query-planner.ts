export interface PlannedQuery {
  query: string;
  reason: string;
}

export function planMemoryQueries(query: string): PlannedQuery[] {
  const normalized = query.trim();
  if (!normalized) return [];
  const planned: PlannedQuery[] = [{ query: normalized, reason: 'original' }];
  const compact = normalized
    .replace(/\b(what|when|where|who|how|did|does|do|is|are|was|were|would|could|should)\b/gi, ' ')
    .replace(/\b(i|me|my|you|your|the|a|an|to|in|on|at|of|for|with|from)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (compact && compact.length >= 4) planned.push({ query: compact, reason: 'content_terms' });

  const numberTerms = normalized.match(/\b\d+(?:\.\d+)?\s*(?:years?|months?|weeks?|days?|hours?|pages?|miles?|km|followers?|percent|%)?\b/gi) ?? [];
  if (numberTerms.length > 0) {
    planned.push({ query: numberTerms.join(' '), reason: 'number_terms' });
  }

  const entityLike = normalized.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) ?? [];
  if (entityLike.length > 0) {
    planned.push({ query: [...new Set(entityLike)].join(' '), reason: 'entity_terms' });
  }

  if (/\b(total|difference|increase|older|consecutive|how long|how many|how much)\b/i.test(normalized)) {
    planned.push({ query: compact.replace(/\b(total|difference|increase|older|consecutive|long|many|much)\b/gi, ' ').trim(), reason: 'multi_hop_terms' });
  }

  const seen = new Set<string>();
  return planned.filter(item => {
    const key = item.query.toLowerCase();
    if (!item.query || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 5);
}

// ─── Structured, intent-aware planning ───────────────────────────────────────

export type QueryIntent =
  | 'commonality'
  | 'attribute'
  | 'temporal'
  | 'multi_hop'
  | 'open_domain'
  | 'generic';

export interface QuerySlot {
  slotId: string;            // 'base' | 'shared' | `entity:${name}`
  kind: 'base' | 'shared' | 'entity';
  targetSpeaker?: string;    // entity name to boost during rerank
  queries: string[];         // search strings for this slot
}

export interface QueryPlan {
  intent: QueryIntent;
  entities: string[];
  slots: QuerySlot[];        // used only by the coverage path
  flatQueries: PlannedQuery[]; // = planMemoryQueries output, for the non-coverage path
}

export interface StructuredPlannerConfig {
  enabled: boolean;          // default true
  maxEntities: number;       // default 4
}

/** Runtime knobs for the retriever's planner-driven routing. */
export interface PlannerConfig {
  /** Master switch for structured planning. Default true (rule-based). */
  enabled: boolean;
  /** Route commonality/attribute intents through coverage merge. Default true. */
  commonalityCoverage: boolean;
  /** Additive rerank boost for a slot's target speaker. Default 0.05. */
  speakerBoost: number;
  /** Per-slot guaranteed candidate count in coverage merge. Default 2. */
  perSlotFloor: number;
  /** Max entities extracted per query. Default 4. */
  maxEntities: number;
  /** Optional LLM planner (default off). */
  llm: { enabled: boolean };
}

export const DEFAULT_PLANNER_CONFIG: PlannerConfig = {
  enabled: true,
  commonalityCoverage: true,
  speakerBoost: 0.05,
  perSlotFloor: 2,
  maxEntities: 4,
  llm: { enabled: false },
};

const DEFAULT_STRUCTURED_CONFIG: StructuredPlannerConfig = { enabled: true, maxEntities: 4 };

// Capitalized tokens that are never entity names (sentence-initial question words,
// months, weekdays). Lowercased for comparison.
const NON_ENTITY_CAPITALIZED = new Set([
  'what', 'when', 'where', 'who', 'whom', 'whose', 'which', 'how', 'why',
  'did', 'does', 'do', 'is', 'are', 'was', 'were', 'would', 'could', 'should',
  'the', 'a', 'an', 'i', 'we', 'they', 'he', 'she', 'it',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);

/** Extract candidate entity names (capitalized words), filtering question words/dates. */
export function extractEntities(query: string, maxEntities = 4): string[] {
  const matches = query.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of matches) {
    // Split multi-word matches and keep only tokens that look like names.
    const parts = raw.split(/\s+/).filter(p => !NON_ENTITY_CAPITALIZED.has(p.toLowerCase()));
    if (parts.length === 0) continue;
    const name = parts.join(' ');
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= maxEntities) break;
  }
  return out;
}

function classifyIntent(query: string, entities: string[]): QueryIntent {
  const q = query.toLowerCase();
  if (entities.length >= 2 && /\b(both|in common|common|shared?|shares|similar(?:ity|ities)?|each of|all of them|alike)\b/.test(q)) {
    return 'commonality';
  }
  if (entities.length === 1 && /\b(what|which)\b/.test(q) && /\b(has|have|did|does|is|was|were|do)\b/.test(q)) {
    return 'attribute';
  }
  if (/\b(when|how long|consecutive|before|after|earlier|later)\b/.test(q) || /\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(query)) {
    return 'temporal';
  }
  if (/\b(total|difference|increase|older|how many|how much)\b/.test(q)) {
    return 'multi_hop';
  }
  if (/\b(might|likely|probably|why|infer|financial status|how does .* feel)\b/.test(q)) {
    return 'open_domain';
  }
  return 'generic';
}

/** Strip question/stop words to leave content/topic terms (shared-slot query). */
function topicTerms(query: string): string {
  return query
    .replace(/\b(what|when|where|who|whom|whose|which|how|why|did|does|do|is|are|was|were|would|could|should|both|in|common|share[ds]?|similar|each|all|of|them)\b/gi, ' ')
    .replace(/\b(i|me|my|you|your|the|a|an|to|on|at|for|with|from|and|or)\b/gi, ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build an intent-aware, slotted query plan.
 * For commonality/attribute intents the slots drive per-entity coverage retrieval;
 * all other intents fall back to the flat planMemoryQueries() path.
 */
export function planStructuredQueries(
  query: string,
  config: StructuredPlannerConfig = DEFAULT_STRUCTURED_CONFIG,
): QueryPlan {
  const normalized = query.trim();
  const flatQueries = planMemoryQueries(normalized);
  if (!config.enabled || !normalized) {
    return { intent: 'generic', entities: [], slots: baseSlot(normalized), flatQueries };
  }

  const entities = extractEntities(normalized, config.maxEntities);
  const intent = classifyIntent(normalized, entities);
  return buildQueryPlan(normalized, intent, entities, flatQueries);
}

/**
 * Assemble a QueryPlan from an already-decided intent + entity list.
 * Shared by the rule-based planStructuredQueries() and the optional LLM planner
 * so slot construction has a single source of truth.
 */
export function buildQueryPlan(
  normalized: string,
  intent: QueryIntent,
  entities: string[],
  flatQueries: PlannedQuery[],
): QueryPlan {
  const topic = topicTerms(normalized);

  if (intent === 'commonality' && entities.length >= 2) {
    const slots: QuerySlot[] = entities.map(name => ({
      slotId: `entity:${name}`,
      kind: 'entity',
      targetSpeaker: name,
      queries: [topic ? `${name} ${topic}` : name, name].filter(Boolean),
    }));
    if (topic) slots.push({ slotId: 'shared', kind: 'shared', queries: [topic] });
    return { intent, entities, slots, flatQueries };
  }

  if (intent === 'attribute' && entities.length >= 1) {
    const name = entities[0];
    const slots: QuerySlot[] = [
      { slotId: `entity:${name}`, kind: 'entity', targetSpeaker: name, queries: [topic ? `${name} ${topic}` : name, name].filter(Boolean) },
      { slotId: 'base', kind: 'base', queries: [normalized] },
    ];
    return { intent, entities, slots, flatQueries };
  }

  return { intent, entities, slots: baseSlot(normalized), flatQueries };
}

function baseSlot(query: string): QuerySlot[] {
  return [{ slotId: 'base', kind: 'base', queries: query ? [query] : [] }];
}

/**
 * Augment a slot's queries with LLM-expansion variant terms so coverage-path
 * slots (entity/shared/base) also benefit from query expansion. For entity
 * slots the variant is scoped to the speaker (`<name> <variant>`) so the
 * lexical variant is searched in that person's turns; shared/base slots use
 * the variant directly. Returns slot.queries unchanged when no variants are
 * supplied (non-regression).
 */
export function augmentSlotQueries(
  slot: QuerySlot,
  variantQueries: string[],
  maxVariants = 3,
): string[] {
  const out = [...slot.queries];
  const seen = new Set(out.map(q => q.toLowerCase()));
  const variants = variantQueries
    .map(v => v.trim())
    .filter(Boolean)
    .slice(0, maxVariants);
  for (const variant of variants) {
    const q = slot.kind === 'entity' && slot.targetSpeaker
      ? `${slot.targetSpeaker} ${variant}`
      : variant;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

/** Extract the speaker label from LoCoMo-style content ("X said: ...") or metadata JSON. */
export function extractSpeaker(content: string, metadataJson?: string | null): string | undefined {
  if (metadataJson) {
    try {
      const meta = JSON.parse(metadataJson) as Record<string, unknown>;
      if (typeof meta.speaker === 'string' && meta.speaker.trim()) return meta.speaker.trim();
    } catch {
      // ignore parse errors, fall through to content parsing
    }
  }
  const match = content.match(/(?:^|\.\s+)([A-Z][a-z]+)\s+said:/);
  return match ? match[1] : undefined;
}
