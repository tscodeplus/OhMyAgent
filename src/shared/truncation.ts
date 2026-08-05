/**
 * Truncate text to a maximum length, appending ellipsis if truncated.
 *
 * Iterates by Unicode code point rather than UTF-16 code unit, so the cut
 * never splits a surrogate pair in half — a plain `slice(0, n)` can leave a
 * lone surrogate (mojibake) at the boundary when the text contains emoji or
 * CJK extension characters, which then leaks into LLM context and stored
 * memories. The result's UTF-16 length never exceeds `maxLength`; `maxLength`
 * includes the ellipsis (when there is room for one).
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;

  // Reserve room for '...'; when maxLength is too small for an ellipsis,
  // cut the body to the limit instead (still code-point safe).
  const useEllipsis = maxLength >= 4;
  const bodyLimit = useEllipsis ? maxLength - 3 : maxLength;
  let result = '';
  for (const ch of text) {
    if (result.length + ch.length > bodyLimit) {
      return useEllipsis ? result + '...' : result;
    }
    result += ch;
  }
  return useEllipsis ? result + '...' : result;
}

/**
 * Truncate tool output with a header showing truncation info.
 * Code-point safe for the same reason as `truncate`.
 */
export function truncateToolOutput(output: string, maxLength: number): string {
  if (output.length <= maxLength) return output;
  let truncated = '';
  for (const ch of output) {
    if (truncated.length + ch.length > maxLength) {
      return `${truncated}\n\n[Output truncated: ${output.length - truncated.length} characters omitted]`;
    }
    truncated += ch;
  }
  const remaining = output.length - truncated.length;
  return `${truncated}\n\n[Output truncated: ${remaining} characters omitted]`;
}
