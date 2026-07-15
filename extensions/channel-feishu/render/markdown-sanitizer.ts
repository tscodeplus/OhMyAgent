/**
 * Feishu markdown sanitizer.
 *
 * Feishu's CardKit markdown parser fails to parse formatting markers
 * (**bold**, *italic*, ~~strikethrough~~) when adjacent to non-Latin
 * characters (CJK, fullwidth punctuation, special quotes, etc.).
 * Inserting zero-width spaces between the markers and these characters
 * provides word boundaries without visible gaps.
 */

const ZWSP = '​';

/** Characters considered "Latin word chars" — they don't need ZWSP boundaries. */
const LATIN_WORD = /[a-zA-Z0-9]/;

/** Non-ASCII, non-space, non-ZWSP — CJK and other scripts that break parsing. */
const NON_LATIN_ADJACENT = /([^\x00-\x7F\s​])/;

// ─── HTML tag stripping ───

/**
 * Strip HTML tags that Feishu's lark_md parser doesn't support.
 * Feishu CardKit markdown only supports a subset of markdown syntax
 * (bold, italic, strikethrough, links, code, lists, quotes, tables).
 * Any HTML tag in the output renders as raw text, so we strip them.
 *
 * Converts <br> / <br/> to newlines, strips all other tags while
 * preserving their inner text content.
 */
function stripHtmlTags(text: string): string {
  // Convert <br> variants to newlines
  let result = text.replace(/<br\s*\/?>/gi, '\n');
  // Strip closing tags: </tag>
  result = result.replace(/<\/[a-zA-Z][a-zA-Z0-9]*\s*>/g, '');
  // Strip opening / self-closing tags with optional attributes: <tag ...> or <tag/>
  result = result.replace(/<[a-zA-Z][a-zA-Z0-9]*(?:\s[^>]*)?\s*\/?>/g, '');
  return result;
}

// ─── Table alignment fix ───

/**
 * Fix common markdown table alignment syntax errors that LLMs produce.
 * Example: |::---:| → |:---:| (double colon)
 *
 * Uses per-cell replacements so multi-column table separators like
 * |:---:|::---| are handled correctly — the previous line-anchored
 * approach would only match single-column separator lines.
 */
function fixTableAlignment(text: string): string {
  // Fix double-colon alignment markers like ::--- or :---:: or ::---::
  // Reduce ::--- → :--- (left-align with doubled colon on left)
  // Preceded by | or whitespace or start-of-line
  let result = text.replace(/(\||\s|^):{2,}(-{3,})/gm, '$1:$2');
  // Reduce ---:: → ---: (right-align with doubled colon on right)
  // Followed by | or whitespace or end-of-line
  result = result.replace(/(-{3,}):{2,}(\||\s|$)/gm, '$1:$2');
  return result;
}

// ─── Per-marker Pass 1 (inner-side ZWSP) ───

/** Regex for **bold** — double asterisks, non-greedy content. */
const BOLD_RE = /\*\*(.+?)\*\*/g;

/** Regex for *italic* — single asterisk not part of ** or ***. */
const ITALIC_RE = /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g;

/** Regex for ~~strikethrough~~ — double tildes. */
const STRIKE_RE = /~~(.+?)~~/g;

interface MarkerRule {
  marker: string;
  regex: RegExp;
}

const MARKERS: MarkerRule[] = [
  { marker: '**', regex: BOLD_RE },
  { marker: '*',  regex: ITALIC_RE },
  { marker: '~~', regex: STRIKE_RE },
];

/**
 * Insert ZWSP between a marker and its inner content when the adjacent
 * content char is non-Latin (not a-zA-Z0-9, not space, not already ZWSP).
 */
function sanitizeInner(text: string, marker: string, regex: RegExp): string {
  return text.replace(regex, (_match, content: string) => {
    let prefix = marker;
    let suffix = marker;
    const first = content[0];
    const last = content[content.length - 1];

    if (first !== undefined && first !== ' ' && first !== ZWSP && !LATIN_WORD.test(first)) {
      prefix = `${marker}${ZWSP}`;
    }
    if (last !== undefined && last !== ' ' && last !== ZWSP && !LATIN_WORD.test(last)) {
      suffix = `${ZWSP}${marker}`;
    }
    return prefix + content + suffix;
  });
}

// ─── Per-marker Pass 2 (outer-side ZWSP) ───

/**
 * Build left-side and right-side regexes for a literal marker string.
 * Escapes any regex-special characters in the marker.
 */
function buildOuterRegexes(marker: string): { left: RegExp; right: RegExp } {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const left = new RegExp(`(${NON_LATIN_ADJACENT.source})${escaped}`, 'g');
  const right = new RegExp(`${escaped}(${NON_LATIN_ADJACENT.source})`, 'g');
  return { left, right };
}

/**
 * Insert ZWSP between a marker and outer non-ASCII characters (CJK, etc.).
 * Only adds ZWSP when the adjacent char is non-ASCII, non-space, and not
 * already ZWSP — punctuation and spaces already provide sufficient boundaries.
 */
function sanitizeOuter(text: string, marker: string): string {
  const { left, right } = buildOuterRegexes(marker);
  let result = text.replace(left, `$1${ZWSP}${marker}`);
  result = result.replace(right, `${marker}${ZWSP}$1`);
  return result;
}

// ─── Public API ───

/**
 * Fix markdown formatting markers in Feishu markdown by inserting
 * zero-width spaces around them when adjacent to non-Latin characters.
 *
 * Handles **bold**, *italic*, and ~~strikethrough~~.
 *
 * Two-pass per marker:
 *   1. Inner-side: ZWSP between marker and content char.
 *   2. Outer-side: ZWSP between marker and surrounding non-ASCII char.
 *
 * @deprecated Use {@link fixFeishuMarkdown} instead.
 */
export function fixFeishuBold(text: string): string {
  return fixFeishuMarkdown(text);
}

/**
 * Fix markdown for Feishu CardKit rendering.
 *
 * Processing order:
 *   1. Strip HTML tags — Feishu lark_md does not support HTML.
 *   2. Fix common table alignment syntax errors (e.g. double colons).
 *   3. Insert ZWSP between formatting markers and non-Latin characters,
 *      so **bold**, *italic*, and ~~strikethrough~~ are parsed correctly.
 *
 * Two-pass per marker:
 *   a. Inner-side: ZWSP between marker and content char.
 *   b. Outer-side: ZWSP between marker and surrounding non-ASCII char.
 */
export function fixFeishuMarkdown(text: string): string {
  let result = text;

  // Pass 0: strip HTML tags (Feishu doesn't support HTML)
  result = stripHtmlTags(result);

  // Pass 0.5: fix common table alignment errors (e.g. ::---:)
  result = fixTableAlignment(result);

  // Pass 1: inner-side ZWSP for all markers
  for (const { marker, regex } of MARKERS) {
    result = sanitizeInner(result, marker, regex);
  }

  // Pass 2: outer-side ZWSP for all markers
  for (const { marker } of MARKERS) {
    result = sanitizeOuter(result, marker);
  }

  return result;
}
