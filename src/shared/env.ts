/**
 * Parse a boolean-ish config/env value. Accepts the canonical env-var string
 * forms ('true' / '1') as well as already-coerced booleans (from parsed YAML).
 * Anything else falls back to `defaultVal`.
 *
 * Consolidated from three near-identical copies (config.ts, config-loader.ts,
 * vision-bridge-config.ts) — the `unknown` signature is a safe superset of the
 * old `string | undefined` ones.
 */
export function envBool(val: unknown, defaultVal: boolean): boolean {
  if (val === undefined || val === null) return defaultVal;
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') return val === 'true' || val === '1';
  return defaultVal;
}
