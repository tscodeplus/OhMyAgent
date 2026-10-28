/**
 * Slug derivation for knowledge pages.
 *
 * A slug is the human-readable half of a page's identity: `knowledge_pages` is
 * unique on `(page_type, slug)`, `[[wikilinks]]` address pages by slug, and the
 * WebUI shows it as the page address. It is therefore *derived*, never typed
 * freely: every input goes through one normalisation pipeline so `Power Query`,
 * `power  query` and `ＰＯＷＥＲ QUERY` all land on `power-query`.
 *
 * Same whitelist as `graph-export/slug.ts` (latin letters, digits, CJK/kana/
 * hangul) for one reason: a Chinese title must stay readable — `知识图谱` is a
 * better slug than a hash — while everything that carries structure (`/`, `\`,
 * `.`, `:`, brackets) is dropped. The vault exporter reuses *its* slugger for
 * file names; this one exists separately because page slugs are a database key
 * rather than a path segment, and the export layer must not become a dependency
 * of the memory layer.
 */

/**
 * Characters kept verbatim. Everything else becomes a separator, so `a/b` and
 * `a b` both collapse to `a-b` instead of producing a nested-looking slug.
 */
const NON_SLUG_CHARS = /[^\p{L}\p{N}]+/gu;

/** Long enough for a Chinese sentence fragment, short enough for a URL. */
const MAX_SLUG_LENGTH = 64;

/** Suffix attempts before `nextFreeSlug` gives up instead of looping forever. */
const MAX_SUFFIX_ATTEMPTS = 999;

/**
 * Derive a slug from arbitrary text (title, topic, or a caller-supplied slug).
 *
 * NFKC first: full-width latin/digits are how a Chinese IME produces `ＰＱ`,
 * and without the fold that becomes nothing at all. Lowercasing is ASCII-safe —
 * Han has no case — and `\p{L}` keeps CJK in place, so the same call serves
 * English and Chinese titles.
 *
 * Returns `''` when the input has no letter or digit at all (emoji titles,
 * punctuation only). Callers decide whether that is an error; `nextFreeSlug`
 * substitutes a stem so a page can still be created.
 */
export function slugify(value: string, maxLength: number = MAX_SLUG_LENGTH): string {
  const matched = value.normalize('NFKC').toLowerCase().replace(NON_SLUG_CHARS, '-');
  let slug = matched.replace(/^-+|-+$/g, '');
  if (slug.length > maxLength) {
    // Slice by code point so a surrogate pair is never cut in half, then drop a
    // separator the cut may have exposed at the end.
    slug = Array.from(slug).slice(0, maxLength).join('').replace(/-+$/g, '');
  }
  return slug;
}

/**
 * First slug not already taken: `base`, then `base-2`, `base-3`, …
 *
 * Only for callers that want a *new* page (curation naming a topic, the WebUI
 * "new page" button). A write that means to update an existing page keeps its
 * slug and bumps `version` instead — suffixing there would silently fork the
 * page into two.
 */
export function nextFreeSlug(
  base: string,
  taken: (slug: string) => boolean,
  maxAttempts: number = MAX_SUFFIX_ATTEMPTS,
): string {
  const stem = base || 'page';
  if (!taken(stem)) return stem;
  for (let suffix = 2; suffix <= maxAttempts + 1; suffix += 1) {
    const candidate = `${stem}-${suffix}`;
    if (!taken(candidate)) return candidate;
  }
  throw new Error(`nextFreeSlug: no free slug for "${stem}" after ${maxAttempts} attempts`);
}
