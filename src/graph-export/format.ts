/**
 * Text rendering helpers shared by the vault projection.
 *
 * The vault is a projection of the database, so two runs over unchanged rows
 * must produce byte-identical notes: timestamps are rendered from the row (never
 * from the clock), and YAML key order follows the object literal order callers
 * pass in.
 */

import { stringify as stringifyYaml } from 'yaml';

/**
 * Render a stored timestamp as ISO-8601 UTC, or null when it is unusable.
 *
 * `memories.created_at`/`updated_at` are INTEGER milliseconds (see the V5
 * migration) but older databases still hold TEXT or epoch seconds, so both
 * shapes are accepted instead of throwing on a legacy row.
 */
export function formatTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // Epoch seconds stay below 1e11 until the year 5138.
    const ms = Math.abs(value) < 1e11 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+(\.\d+)?$/.test(trimmed)) return formatTimestamp(Number(trimmed));
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? trimmed : date.toISOString();
  }
  return null;
}

/** YAML frontmatter block for a note, with a trailing blank line before the body. */
export function frontmatterBlock(data: Record<string, unknown>): string {
  const yamlText = stringifyYaml(data, { lineWidth: 0 }).replace(/\n+$/, '');
  return `---\n${yamlText}\n---\n`;
}

/** Collapse any line breaks so stored text cannot break a Markdown heading. */
export function singleLine(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Inner text of an Obsidian wikilink: `]]`, `|`, `#` and `^` are link syntax,
 * so a name containing them would otherwise close the link early or turn the
 * rest of the line into an alias/heading anchor.
 */
export function wikilinkTarget(text: string): string {
  return singleLine(text)
    .replace(/[[\]|#^]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `[[target|label]]`, or plain text when the target sanitises away. */
export function wikilink(target: string, label?: string): string {
  const safeTarget = wikilinkTarget(target);
  if (!safeTarget) return label ? wikilinkTarget(label) : '';
  const safeLabel = label ? wikilinkTarget(label) : '';
  if (!safeLabel || safeLabel === safeTarget) return `[[${safeTarget}]]`;
  return `[[${safeTarget}|${safeLabel}]]`;
}

/** Confidence rendered to two decimals so repeated runs cannot drift in width. */
export function formatConfidence(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(2);
}
