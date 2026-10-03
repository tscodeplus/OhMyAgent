// ---------------------------------------------------------------------------
// v4 Policy — tool-name pattern matching for skill / server allow-deny lists
// ---------------------------------------------------------------------------
//
// See MyDocs/MCP_INTEGRATION_DESIGN.md §12.2.
//
// The syntax is deliberately minimal: a *trailing* `*` means prefix match, and
// a `*` anywhere else is a literal character. A pattern without a trailing `*`
// therefore behaves exactly like the `Set.has()` lookup it replaces, so this is
// fully backward compatible with the six exact-match sites it centralises.
//
// Why centralise: MCP tool names may carry a disambiguating 8-char hash suffix
// (see §6.1), so a user cannot type the full name. Only a trailing wildcard
// makes those tools addressable, and fixing that at one site would let
// `tool_search` unlock a tool that PolicyCenter then refuses to execute.

/** True when the pattern matches the tool name. */
export function matchesToolPattern(pattern: string, toolName: string): boolean {
  if (pattern === '*') return true;

  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    // A non-trailing `*` is a literal, so only prefix-match when the remainder
    // is wildcard-free — `a*b*` must not silently become `startsWith('a*b')`.
    if (!prefix.includes('*')) return toolName.startsWith(prefix);
  }

  return pattern === toolName;
}

/** True when any pattern matches the tool name. */
export function matchesAnyToolPattern(
  patterns: readonly string[] | undefined | null,
  toolName: string,
): boolean {
  if (!patterns || patterns.length === 0) return false;
  for (const pattern of patterns) {
    if (matchesToolPattern(pattern, toolName)) return true;
  }
  return false;
}

/** Keep only the tools matched by at least one pattern. */
export function filterByToolPatterns<T extends { name: string }>(
  tools: readonly T[],
  patterns: readonly string[] | undefined | null,
): T[] {
  if (!patterns || patterns.length === 0) return [];
  return tools.filter((tool) => matchesAnyToolPattern(patterns, tool.name));
}

/** Drop the tools matched by at least one pattern. */
export function rejectByToolPatterns<T extends { name: string }>(
  tools: readonly T[],
  patterns: readonly string[] | undefined | null,
): T[] {
  if (!patterns || patterns.length === 0) return [...tools];
  return tools.filter((tool) => !matchesAnyToolPattern(patterns, tool.name));
}

/**
 * Resolve the first matching pattern, used for "most specific wins" lookups
 * such as `mcp.tool_exposure` overrides (§5.1). Returns `undefined` when no
 * pattern matches.
 */
export function firstMatchingToolPattern(
  patterns: readonly string[] | undefined | null,
  toolName: string,
): string | undefined {
  if (!patterns) return undefined;
  for (const pattern of patterns) {
    if (matchesToolPattern(pattern, toolName)) return pattern;
  }
  return undefined;
}
