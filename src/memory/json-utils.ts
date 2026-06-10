/**
 * Shared JSON extraction utilities used by LLM-response parsers.
 *
 * Extracts a JSON object string from an LLM response that may contain
 * markdown code fences or surrounding text.
 *
 * Used by persona-distiller.ts and mermaid-phase-tagger.ts.
 */

/**
 * Extract a JSON object string from text that may contain markdown code fences
 * or extra text surrounding the JSON.
 *
 * Strategy (tried in order):
 * 1. Extract from markdown fenced code block (```json ... ```)
 * 2. Extract the outermost `{...}` block
 * 3. Use the whole text if it starts/ends with `{}`
 *
 * @returns The cleaned JSON string, or `null` if no JSON-like content found.
 */
export function extractJson(text: string): string | null {
  // 1. Try markdown code fence with optional "json" language tag
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    const candidate = fenceMatch[1].trim();
    if (candidate) return candidate;
  }

  // 2. Try the outermost {...} block
  const braceMatch = text.match(/(\{[\s\S]*\})/);
  if (braceMatch) {
    const candidate = braceMatch[1].trim();
    if (candidate) return candidate;
  }

  // 3. If the whole response looks like a JSON object, use it directly
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;

  return null;
}
