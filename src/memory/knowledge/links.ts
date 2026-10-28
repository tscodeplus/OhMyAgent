/**
 * `[[wikilink]]` parsing for knowledge page bodies.
 *
 * Page-to-page relations are written inline, in markdown, and parsed into
 * `knowledge_links` at write time. Accepted forms — deliberately only these two
 * (plus Obsidian's display alias), because an untyped target can only be
 * resolved by guessing:
 *
 *   [[power-query]]              slug; must be unique across page types to resolve
 *   [[topic/power-query]]        page type + slug; always unambiguous
 *   [[topic/power-query|PQ]]     same, with a display label
 *
 * A target that resolves to no page is *dangling*: it is reported to the caller
 * and written to `knowledge_log`, and the page is still saved. Refusing the
 * write would mean a page could never link forward to a page written tomorrow,
 * and a citation graph is allowed to be incomplete.
 */

import type { PageType } from './types.js';
import { isPageType } from './types.js';
import { slugify } from './slug.js';

/**
 * `[[target]]` / `[[target|label]]`. The target class excludes `|`, `[`, `]`
 * and newlines so the optional label group is the only thing that can follow a
 * `|` — a body containing `[[a|b]]` must not parse as target `a|b`.
 */
const WIKILINK_PATTERN = /\[\[([^[\]|\n]+?)(?:\|([^[\]\n]*))?\]\]/g;

/** One parsed `[[wikilink]]`. `target` is the display form and doubles as the dedupe key. */
export interface ParsedWikilink {
  /** `page_type/slug` when typed, else the bare slug. Used for reporting. */
  target: string;
  /** Explicit type from `[[page_type/slug]]`; null for the untyped form. */
  pageType: PageType | null;
  slug: string;
  /** Display label from `[[target|label]]`; null when the link has none. */
  label: string | null;
}

/**
 * Extract every distinct wikilink in `content`, first-seen order.
 *
 * Distinct by `(pageType, slug)`: two links that differ only by label are one
 * relation, because `knowledge_links` is keyed on `(from_page_id, to_page_id)`.
 */
export function parseWikilinks(content: string): ParsedWikilink[] {
  const seen = new Set<string>();
  const links: ParsedWikilink[] = [];

  for (const match of content.matchAll(WIKILINK_PATTERN)) {
    const rawTarget = match[1].trim();
    if (!rawTarget) continue;

    const { pageType, rest } = splitTypePrefix(rawTarget);
    const slug = slugify(rest);
    if (!slug) continue; // emoji- or punctuation-only target: not addressable

    const target = pageType ? `${pageType}/${slug}` : slug;
    if (seen.has(target)) continue;
    seen.add(target);

    const label = match[2]?.trim();
    links.push({ target, pageType, slug, label: label ? label : null });
  }

  return links;
}

/**
 * Split `page_type/slug`. The prefix only counts as a type when it is one of the
 * closed set — otherwise `[[notes/2024]]` is a single slug (`notes-2024`), not a
 * page of a nonexistent type.
 */
function splitTypePrefix(target: string): { pageType: PageType | null; rest: string } {
  const slash = target.indexOf('/');
  if (slash <= 0) return { pageType: null, rest: target };
  const prefix = target.slice(0, slash);
  if (!isPageType(prefix)) return { pageType: null, rest: target };
  return { pageType: prefix, rest: target.slice(slash + 1) };
}

/** A link that resolved to a page row. */
export interface ResolvedWikilink {
  toPageId: string;
  label: string | null;
  target: string;
}

export interface WikilinkResolution {
  /** Links whose target exists. */
  links: ResolvedWikilink[];
  /** Display form of every target that resolved to nothing. */
  dangling: string[];
}

/**
 * Resolve parsed links through `lookup` (which returns a page id or null).
 *
 * `lookup` is the caller's policy boundary: the repository's implementation
 * only resolves `status = 'active'` pages, so a pending page is invisible to
 * link resolution and its slug stays dangling until it is approved.
 *
 * Self-links are dropped rather than reported as dangling — a page mentioning
 * its own title is prose, not a broken relation.
 */
export function resolveWikilinks(
  content: string,
  lookup: (link: ParsedWikilink) => string | null,
  options: { selfPageId?: string | null } = {},
): WikilinkResolution {
  const links: ResolvedWikilink[] = [];
  const dangling: string[] = [];
  const seenPageIds = new Set<string>();

  for (const link of parseWikilinks(content)) {
    const toPageId = lookup(link);
    if (!toPageId) {
      dangling.push(link.target);
      continue;
    }
    if (options.selfPageId && toPageId === options.selfPageId) continue;
    if (seenPageIds.has(toPageId)) continue;
    seenPageIds.add(toPageId);
    links.push({ toPageId, label: link.label, target: link.target });
  }

  return { links, dangling };
}
