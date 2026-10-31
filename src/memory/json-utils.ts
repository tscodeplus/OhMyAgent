/**
 * Shared JSON extraction utilities used by LLM-response parsers.
 *
 * Extracts a JSON object string from an LLM response that may contain
 * markdown code fences or surrounding text.
 *
 * Used by persona-distiller.ts, mermaid-phase-tagger.ts and the notes distiller.
 */

/**
 * Extract a JSON object string from text that may contain markdown code fences
 * or extra text surrounding the JSON.
 *
 * Candidates are tried **in order of how direct they are**, and each is checked
 * by parsing before it is returned:
 *
 * 1. the whole trimmed response, when it already looks like an object;
 * 2. the outermost `{...}` block, for a reply with a sentence of preamble;
 * 3. a fenced block, for a reply that fenced the JSON *and* printed more after it.
 *
 * The order matters and used to be wrong: a fence was tried first, so a response
 * whose JSON was fine but whose `body` field contained its own code fence — which
 * is what a note storing a command looks like — had that inner fence promoted to
 * "the JSON". The candidate was then unparsable and a perfectly good note was
 * discarded as `invalid_json`. Parsing each candidate in order fixes that without
 * weakening the fenced case, which still resolves through step 2 or step 3.
 *
 * @returns The JSON string to parse, or `null` if the response holds no
 * JSON-like content at all.
 */
export function extractJson(text: string): string | null {
  const trimmed = text.trim();
  // 1. The response *is* the object: the common case, and the one that must never
  //    be second-guessed (see the note about inner fences above).
  const whole = trimmed.startsWith('{') && trimmed.endsWith('}') ? trimmed : null;

  // 2. The outermost {@code {...}} block, for replies wrapped in prose.
  const brace = text.match(/(\{[\s\S]*\})/)?.[1].trim() ?? null;

  // 3. A fenced block, for a reply that fenced the JSON and kept talking after it.
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/)?.[1].trim() ?? null;

  const candidates = [whole, brace, fenced].filter((candidate): candidate is string => !!candidate);
  for (const candidate of candidates) {
    if (parses(candidate)) return candidate;
  }
  // Nothing parsed: hand back the best guess so the caller's own parse reports the
  // failure with its own detail instead of "no JSON at all".
  return candidates[0] ?? null;
}

function parses(candidate: string): boolean {
  try {
    JSON.parse(candidate);
    return true;
  } catch {
    return false;
  }
}
