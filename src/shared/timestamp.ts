// ---------------------------------------------------------------------------
// Timestamp parsing for SQLite TEXT columns
// ---------------------------------------------------------------------------

/**
 * Parse a timestamp column into epoch milliseconds.
 *
 * The schema declares most `created_at`/`updated_at` columns as TEXT with
 * `DEFAULT (cast(strftime('%s','now') as integer) * 1000)`, so SQLite stores
 * the epoch millis as a bare digit string ("1788237296000"). `new Date()`
 * does NOT accept that form — it returns Invalid Date, so `getTime()` yields
 * NaN and every downstream comparison silently becomes false. Rows written by
 * application code may instead be ISO-8601, and older rows may be SQLite
 * `datetime('now')` strings, so all three shapes have to be understood at
 * every read site.
 *
 * Returns 0 when the value cannot be interpreted. Callers that use the result
 * for decay or ordering treat 0 as "unknown" and leave the row untouched,
 * which is safer than a NaN that poisons comparisons.
 */
export function parseEpochMs(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value !== 'string' || value.length === 0) {
    return 0;
  }
  // Bare epoch millis (the column DEFAULT shape).
  if (/^\d+$/.test(value)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
