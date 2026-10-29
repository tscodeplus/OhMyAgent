/**
 * File-name slugs for the Obsidian vault projection.
 *
 * Entity names and memory ids come from the database, i.e. from model output and
 * chat input, so a "name" can be `../../etc/passwd`, an absolute path, or a
 * Windows reserved device name. A generated note must never land outside the
 * vault, so every path segment is reduced to a whitelist of characters that
 * cannot carry path meaning: latin letters, digits, and CJK ideographs/kana/
 * hangul (the vault must stay readable for Chinese notes).
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * Characters kept verbatim. Everything else (including `/`, `\`, `:`, `.`,
 * control characters, and `..`) becomes a separator and is then collapsed.
 */
const SEGMENT_CHARS = /[a-z0-9\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\uf900-\ufaff]+/g;

const MAX_SEGMENT_LENGTH = 64;

/** Windows device names are rejected by the filesystem even with a suffix. */
const RESERVED_SEGMENTS = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

/**
 * Reduce arbitrary text to a safe path segment. Returns '' when the input has
 * no whitelisted characters at all (callers use {@link safeFileStem} instead of
 * accepting an empty segment).
 */
export function slugifySegment(value: string, maxLength = MAX_SEGMENT_LENGTH): string {
  const matched = value.normalize('NFKC').toLowerCase().match(SEGMENT_CHARS);
  if (!matched) return '';
  let slug = matched.join('-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (slug.length > maxLength) {
    slug = slug.slice(0, maxLength).replace(/-+$/, '');
  }
  if (!slug || RESERVED_SEGMENTS.has(slug)) return '';
  return slug;
}

/**
 * Slug that is always usable as a file name. Inputs with nothing whitelisted
 * (e.g. an emoji-only entity name) fall back to a hash of the raw value so the
 * mapping stays deterministic across runs.
 */
export function safeFileStem(value: string, maxLength = MAX_SEGMENT_LENGTH): string {
  const slug = slugifySegment(value, maxLength);
  if (slug) return slug;
  return `note-${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
}

export class VaultPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultPathError';
  }
}

/**
 * Join segments onto `root` and refuse anything that resolves outside it.
 * The slug whitelist already makes traversal impossible; this is the belt to
 * that suspenders, since a future caller may pass a segment that was not
 * slugified (the state file, for instance).
 */
export function safeJoin(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...segments);
  const relative = path.relative(resolvedRoot, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new VaultPathError(`refusing to write outside the vault: ${target}`);
  }
  return target;
}

/**
 * True when `relativePath` is one of the note paths this exporter generates.
 *
 * `pages/` is one namespace at three depths, because a page's address carries
 * what makes it unique: `pages/<slug>.md` (a row with no usable page type),
 * `pages/<page_type>/<slug>.md` (a global page) and
 * `pages/<scope>/<page_type>/<slug>.md` (a page from one conversation). Every
 * depth has to be recognised, or a note written one run becomes a note the next
 * run cannot delete.
 */
export function isGeneratedNotePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  return (
    normalized === 'index.md' ||
    /^pages\/(?:[^/]+\/){0,2}[^/]+\.md$/.test(normalized) ||
    /^entities\/[^/]+\.md$/.test(normalized) ||
    /^memories\/[^/]+\.md$/.test(normalized) ||
    /^sessions\/[^/]+\.md$/.test(normalized)
  );
}
