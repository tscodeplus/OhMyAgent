// ---------------------------------------------------------------------------
// Tool search engine — regex + name matching
// ---------------------------------------------------------------------------
//
// Strategy (in priority order):
//   1. Exact name match (case-insensitive)
//   2. Regex match — the model constructs a pattern targeting tool names it
//      already sees in the tool_search description
//   3. Substring match — query is a substring of the tool name or vice versa
//   4. Token overlap — every query token appears in the tool name
//   5. Description search — token match against name + description
//
// This is intentionally NOT semantic search. The model reads available tool
// names from the tool_search description and constructs a precise pattern
// to retrieve the right one.

const TOKEN_RE = /[A-Za-z0-9]+/g;

/** Max regex pattern length to prevent ReDoS. */
const MAX_REGEX_LENGTH = 200;

/** Regex execution timeout in ms. */
const REGEX_TIMEOUT_MS = 50;

/** A catalog entry for search. */
export interface CatalogEntry {
  name: string;
  label: string;
  description: string;
  category: string;
  /** Lower-case tokens from the tool name. */
  nameTokens: string[];
  /** Lower-case tokens from name + description. */
  tokens: string[];
}

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

/**
 * Tokenize text for indexing.
 *
 * Expands snake_case, dot.case, kebab-case, and colon:separated names
 * before extracting alphanumeric tokens.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const expanded = text
    .replace(/_/g, ' ')
    .replace(/\./g, ' ')
    .replace(/-/g, ' ')
    .replace(/:/g, ' ');
  const tokens: string[] = [];
  for (const m of expanded.matchAll(TOKEN_RE)) {
    const lower = m[0].toLowerCase();
    if (lower) tokens.push(lower);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Catalog building
// ---------------------------------------------------------------------------

/**
 * Build a pre-tokenized catalog from raw tool metadata.
 */
export function buildCatalog(
  entries: { name: string; label: string; description: string; category: string; paramNames?: string }[],
): CatalogEntry[] {
  return entries.map((e) => {
    const nameTokens = tokenize(e.name);
    const descText = [e.label, e.description];
    if (e.paramNames) descText.push(e.paramNames);
    const descTokens = tokenize(descText.join(' '));

    return {
      name: e.name,
      label: e.label,
      description: e.description,
      category: e.category,
      nameTokens,
      tokens: [...nameTokens, ...descTokens],
    };
  });
}

// ---------------------------------------------------------------------------
// Regex utilities
// ---------------------------------------------------------------------------

/**
 * Try to compile a query as a regex. Returns null if the pattern is invalid
 * or too long (ReDoS protection).
 */
function tryCompileRegex(query: string): RegExp | null {
  const trimmed = query.trim();
  if (!trimmed || trimmed.length > MAX_REGEX_LENGTH) return null;

  try {
    // Reject known-dangerous patterns
    if (/\(.*\(.*\(.*\(/.test(trimmed)) return null; // deep nesting
    if (/(\*\s*){3,}/.test(trimmed)) return null; // excessive quantifiers
    if (/(\+|\*)\s*(\+|\*)/.test(trimmed)) return null; // adjacent quantifiers

    const re = new RegExp(trimmed, 'i');
    // Test it compiles; don't execute yet
    return re;
  } catch {
    return null;
  }
}

/**
 * Safely test a regex against a string with a timeout guard.
 */
function safeRegexTest(re: RegExp, str: string): boolean {
  const start = Date.now();
  try {
    // Use a simple timeout via string length guard — if the pattern
    // is a simple tool-name regex it should complete instantly.
    if (str.length > 500) return false;
    const result = re.test(str);
    // If it took more than the timeout, consider it a non-match
    if (Date.now() - start > REGEX_TIMEOUT_MS) return false;
    return result;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Search strategies (ordered by priority)
// ---------------------------------------------------------------------------

/**
 * Strategy 1: Exact name match (case-insensitive).
 * "image_generation" === "image_generation"
 */
function exactNameMatch(query: string, catalog: CatalogEntry[]): CatalogEntry[] {
  const ql = query.trim().toLowerCase();
  return catalog.filter((e) => e.name.toLowerCase() === ql);
}

/**
 * Strategy 2: Regex match against tool names.
 * Model constructs pattern like "image.*generat" → matches "image_generation".
 */
function regexNameMatch(query: string, catalog: CatalogEntry[]): CatalogEntry[] {
  const re = tryCompileRegex(query);
  if (!re) return [];
  return catalog.filter((e) => safeRegexTest(re, e.name));
}

/**
 * Strategy 3: Bidirectional substring match on tool name.
 * "generate image" contains "image", "config" is contained in "update config".
 */
function substringNameMatch(query: string, catalog: CatalogEntry[]): CatalogEntry[] {
  const ql = query.trim().toLowerCase();
  if (!ql) return [];
  return catalog.filter((e) => {
    const nl = e.name.toLowerCase();
    return nl.includes(ql) || ql.includes(nl);
  });
}

/**
 * Strategy 4: All query tokens appear in the tool name tokens.
 * query tokens: ["memory", "persona", "rebuild"]
 * name tokens: ["memory", "rebuild", "persona"] → match (all present)
 */
function tokenNameMatch(query: string, catalog: CatalogEntry[]): CatalogEntry[] {
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return [];
  const querySet = new Set(queryTokens);
  return catalog.filter((e) => {
    const nameSet = new Set(e.nameTokens);
    return [...querySet].every((t) => nameSet.has(t));
  });
}

/**
 * Strategy 5: Token overlap against name + description (fallback).
 * Used only when the query doesn't target a specific tool name.
 */
function tokenDescMatch(
  query: string,
  catalog: CatalogEntry[],
): CatalogEntry[] {
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return [];
  const querySet = new Set(queryTokens);

  const scored = catalog
    .map((e) => {
      const docSet = new Set(e.tokens);
      const overlap = [...querySet].filter((t) => docSet.has(t)).length;
      return { entry: e, score: overlap };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.map((r) => r.entry);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Search a catalog for entries matching the given query.
 *
 * Tries each strategy in priority order. The FIRST strategy that yields
 * results is returned immediately — no ranking across strategies.
 *
 * Strategy order:
 *   1. Exact name match (case-insensitive)
 *   2. Regex match against tool names
 *   3. Bidirectional substring match on tool name
 *   4. All query tokens present in tool name tokens
 *   5. Token overlap against name + description (fallback)
 *
 * Within a strategy, results are sorted alphabetically by name for
 * deterministic ordering.
 *
 * @returns Top-matching entries, up to ``limit``.
 */
export function searchCatalog(
  catalog: CatalogEntry[],
  query: string,
  limit: number,
): CatalogEntry[] {
  if (!catalog.length || limit <= 0) return [];

  const strategies: Array<{ name: string; fn: () => CatalogEntry[] }> = [
    { name: 'exact', fn: () => exactNameMatch(query, catalog) },
    { name: 'regex', fn: () => regexNameMatch(query, catalog) },
    { name: 'substring', fn: () => substringNameMatch(query, catalog) },
    { name: 'token-name', fn: () => tokenNameMatch(query, catalog) },
    { name: 'token-desc', fn: () => tokenDescMatch(query, catalog) },
  ];

  for (const strategy of strategies) {
    const hits = strategy.fn();
    if (hits.length > 0) {
      // Sort deterministically: for un-ranked strategies use alphabetical
      // order; token-desc already pre-sorts by relevance score
      if (strategy.name !== 'token-desc') {
        hits.sort((a, b) => a.name.localeCompare(b.name));
      }
      return hits.slice(0, limit);
    }
  }

  return [];
}
