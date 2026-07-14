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
 * Fix markdown formatting markers in Feishu markdown by inserting
 * zero-width spaces around them when adjacent to non-Latin characters.
 *
 * Handles **bold**, *italic*, and ~~strikethrough~~.
 *
 * Two-pass per marker:
 *   1. Inner-side: ZWSP between marker and content char.
 *   2. Outer-side: ZWSP between marker and surrounding non-ASCII char.
 */
export function fixFeishuMarkdown(text: string): string {
  let result = text;

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
