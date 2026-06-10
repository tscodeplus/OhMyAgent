/**
 * Extract plain text from pi-mono's structured content format.
 *
 * pi-mono messages store content as an array of typed blocks:
 *   [{type: "text", text: "..."}, {type: "thinking", thinking: "..."}, ...]
 *
 * This extracts text-type blocks and joins them.
 */
export function extractText(content: unknown): string {
  if (typeof content === 'string') return stripXmlTag(content, 'think');
  if (!Array.isArray(content)) return String(content);

  return content
    .filter((block): block is { type: string; text: string } =>
      typeof block === 'object' && block !== null && 'text' in block && typeof (block as any).text === 'string'
    )
    .map((block) => stripXmlTag(block.text, 'think'))
    .join('\n');
}

/**
 * Strip a paired XML tag and its content from text using indexOf (no regex).
 * Handles the tag appearing anywhere in the string, not just at the start.
 */
export function stripXmlTag(text: string, tag: string): string {
  const openTag = `<${tag}>`;
  const closeTag = `</${tag}>`;
  let result = text;
  let start = result.indexOf(openTag);
  while (start !== -1) {
    const end = result.indexOf(closeTag, start + openTag.length);
    if (end === -1) break; // unclosed tag — leave as-is
    result = result.slice(0, start) + result.slice(end + closeTag.length);
    start = result.indexOf(openTag);
  }
  return result;
}

/** Block prefixes injected by context-transform.ts as date/time context. */
const INJECTED_PREFIXES = ['[当前时间', '[当前日期', '[Current time', '[Current date'];

/**
 * Like extractText, but skips text blocks that are injected date/time
 * context prefixes (added by context-transform). This extracts only
 * the user's original message content for persistence.
 */
export function extractUserText(content: unknown): string {
  if (typeof content === 'string') {
    // Strip system-reminder blocks (skill activation etc.) and injected date/time prefixes
    const cleaned = stripXmlTag(content, 'system-reminder').trimStart();
    for (const prefix of INJECTED_PREFIXES) {
      if (cleaned.startsWith(prefix)) {
        const idx = cleaned.indexOf(']');
        return idx >= 0 ? cleaned.slice(idx + 1).trimStart() : cleaned;
      }
    }
    return cleaned;
  }
  if (!Array.isArray(content)) return String(content);

  return content
    .filter((block): block is { type: string; text: string } => {
      if (typeof block !== 'object' || block === null) return false;
      if (!('text' in block) || typeof (block as any).text !== 'string') return false;
      // Skip injected date/time context blocks
      const t = (block as any).text.trimStart();
      for (const prefix of INJECTED_PREFIXES) {
        if (t.startsWith(prefix)) return false;
      }
      return true;
    })
    .map((block) => (block as any).text as string)
    .join('\n');
}
