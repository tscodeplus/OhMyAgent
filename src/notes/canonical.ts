/**
 * Canonical forms for notes: the title comparison key and tag normalisation.
 *
 * Both exist because the same fact arrives spelled differently — `Termux 换源`,
 * `termux换源`, `Termux-换源` are one subject, and `#Testing` / `testing` are one
 * tag. Storing the raw text and comparing it at read time would make every
 * lookup re-derive the rule (and eventually disagree with the writer), so the
 * comparison key is a column: `notes.normalized_title`.
 *
 * The folding is deliberately aggressive on whitespace/punctuation and
 * deliberately conservative otherwise: case, spacing, hyphens and underscores
 * fold (a user typing `pnpm-lock` and `pnpm lock` means one thing), while dots
 * and slashes survive because `Node.js` and `a/b` are names, not punctuation.
 */

/** Characters dropped from a title before comparison. */
const TITLE_NOISE = /[\s\-_·・]+/g;
/**
 * Punctuation kept out of the comparison key (CJK full-width included).
 *
 * `.` and `/` are deliberately absent: `Node.js` and `a/b` are names, not
 * punctuation, and folding them merges two different subjects.
 */
const TITLE_PUNCTUATION = /[!"#$%&'()*+,:;<=>?@[\\\]^`{|}~，。、；：？！“”‘’（）《》【】…—]/g;

/**
 * The key a title is compared under.
 *
 * Not a slug: a slug is for URLs and export filenames (see `slugify`), and using
 * one for comparison would make `vitest 单文件迭代` and `vitest-单文件迭代`
 * distinct subjects.
 */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(TITLE_NOISE, '')
    .replace(TITLE_PUNCTUATION, '');
}

/**
 * A tag as stored: no `#`, no surrounding space, lower case, single words.
 * Tags with internal spaces are joined with `-` rather than dropped — a user who
 * types `feishu card` means one tag, and silently keeping only `feishu` would
 * look like the input was ignored.
 */
export function normalizeTag(raw: string): string {
  return raw
    .normalize('NFKC')
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .slice(0, 24);
}

/** Tags as stored: normalised, de-duplicated, order preserved, max 6. */
export function normalizeTags(raw: readonly string[] | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const tag = normalizeTag(item);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * A filename-safe slug, used by the export script (M4) and nothing else.
 * Distinct from `normalizeTitle` on purpose: export wants `vitest-单文件迭代`
 * where comparison wants `vitest单文件迭代`.
 */
export function slugify(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/[\s/\\]+/g, '-')
    .replace(/[^\p{Letter}\p{Number}-]+/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}
