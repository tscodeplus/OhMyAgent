// ---------------------------------------------------------------------------
// MCP credential masking for API responses
// ---------------------------------------------------------------------------
//
// See MyDocs/MCP_INTEGRATION_DESIGN.md §13.7 (masking rule) and §18 P3
// acceptance ("列表接口不泄露 OAuth token;env/headers 中的密钥被掩码").
//
// Two API surfaces hand MCP config back to the browser — `/api/mcp/*` and the
// generic `/api/config` — and they must agree, or the stricter one is pointless
// because the other still leaks. Both route through this module.
//
// The rule is name-based rather than value-based: a key matching Authorization,
// *_TOKEN, *_SECRET or *_KEY is masked regardless of what it holds. That is
// deliberately conservative — masking a non-secret is harmless, echoing a real
// secret is not.
//
// A name-based rule cannot see a credential that is embedded in a *value* — a
// URL's userinfo or query string — so `maskUrl()` covers that case separately.
//
// Known gap (reported, not fixed here): `${VAR}` interpolation runs in
// `config-loader.ts` before this module's caller ever sees the config, so a
// value stored under a non-secret-looking key (`SESSION`, `X-Team`) is returned
// in plaintext. Masking those would be unround-trippable — the client cannot
// tell a real value from the placeholder once it is echoed back — so the
// documented rule stays the key-name one.

import type { McpOAuthConfig, McpSectionConfig, McpServerConfig } from './types.js';

/** Placeholder substituted for a secret value. */
export const MASKED_SECRET = '••••••';

const SECRET_SUFFIXES = ['token', 'secret', 'key', 'password', 'passwd', 'credential'];
const SECRET_EXACT = ['authorization', 'auth', 'cookie', 'set-cookie', 'proxy-authorization'];

/**
 * Qualifiers that make a separator-less concatenation a secret key.
 *
 * `APIKEY`, `AUTHTOKEN` and `CLIENTSECRET` have neither a separator nor a
 * lower-to-upper boundary, so neither rule above sees them. The suffix alone is
 * not enough — `MONKEY` ends in `key` too — so a concatenated spelling only
 * counts when the part before the suffix is one of these qualifiers.
 */
const SECRET_QUALIFIERS = new Set([
  'api',
  'auth',
  'access',
  'client',
  'session',
  'refresh',
  'bearer',
  'oauth',
  'personal',
  'private',
  'secret',
]);

/**
 * True when a config key should be masked.
 *
 * Matches `Authorization` exactly, and anything whose separator-delimited last
 * segment is a secret word (`X-Api-Key`, `GITHUB_TOKEN`, `docs.secret`), plus
 * camelCase spellings with no separator (`apiKey`, `accessToken`) and
 * separator-less concatenations (`APIKEY`, `authToken`).
 *
 * The camelCase branch requires a real lowercase-to-uppercase boundary rather
 * than a plain case-insensitive `endsWith`, so an ordinary word that merely
 * ends in those letters — `MONKEY` — is not masked as if it were a key. The
 * concatenation branch needs its own guard for the same reason: it only fires
 * when the leading characters are a known qualifier.
 */
export function isSecretKey(key: string): boolean {
  const trimmed = key.trim();
  if (!trimmed) return false;
  const normalized = trimmed.toLowerCase();
  if (SECRET_EXACT.includes(normalized)) return true;

  // Separator-delimited spellings: `x-api-key`, `GITHUB_TOKEN`, `docs.secret`.
  // A bare `key` / `token` / `secret` also lands here and is treated as secret.
  const segments = normalized.split(/[-_.\s]+/).filter(Boolean);
  const last = segments[segments.length - 1];
  if (last && SECRET_SUFFIXES.includes(last)) return true;

  // camelCase spellings with no separator: `apiKey`, `accessToken`,
  // `clientSecret`. Require a lowercase-then-uppercase boundary.
  for (const suffix of SECRET_SUFFIXES) {
    const start = trimmed.length - suffix.length;
    if (start <= 0) continue;
    if (trimmed.slice(start).toLowerCase() !== suffix) continue;

    const boundary = trimmed[start];
    const before = trimmed[start - 1];
    const boundaryIsUpper =
      boundary === boundary.toUpperCase() && boundary !== boundary.toLowerCase();
    const beforeIsLower = before === before.toLowerCase() && before !== before.toUpperCase();
    if (boundaryIsUpper && beforeIsLower) return true;
  }

  // Separator-less concatenations of a qualifier and a secret word, in any
  // casing: `APIKEY`, `apikey`, `AUTHTOKEN`, `clientSecret`.
  for (const suffix of SECRET_SUFFIXES) {
    if (!normalized.endsWith(suffix)) continue;
    const qualifier = normalized.slice(0, normalized.length - suffix.length);
    if (SECRET_QUALIFIERS.has(qualifier)) return true;
  }

  return false;
}

/** Mask a single secret value, keeping nothing of the original. */
export function maskSecretValue(value: string): string {
  return value ? MASKED_SECRET : value;
}

/** Mask the values of a key/value map, leaving non-secret keys untouched. */
export function maskRecord(
  record: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!record) return record;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = isSecretKey(key) ? maskSecretValue(value) : value;
  }
  return out;
}

function maskOAuth(oauth: McpOAuthConfig | undefined): McpOAuthConfig | undefined {
  if (!oauth) return oauth;
  return {
    ...oauth,
    clientSecret: maskSecretValue(oauth.clientSecret),
  };
}

/**
 * Percent-encoded form of {@link MASKED_SECRET}.
 *
 * `new URL()` percent-encodes the non-ASCII bullet, so a masked URL would come
 * back as `%E2%80%A2…` — unreadable, and no longer the placeholder every other
 * API field uses. {@link maskUrl} undoes it on the way out.
 */
const ENCODED_MASKED_SECRET = encodeURIComponent(MASKED_SECRET);

function decodeMaskPlaceholder(value: string): string {
  return value.split(ENCODED_MASKED_SECRET).join(MASKED_SECRET);
}

/**
 * Mask the credential-bearing parts of a server URL (§13.7).
 *
 * A URL can carry credentials in two places the key-based rule never sees:
 * userinfo (`https://svc:ghp_token@host/mcp`) and the query string
 * (`?access_token=…`). Both are masked here so HTTP servers leak nothing.
 *
 * Not a round-trip-safe transformation on its own: a client that echoes the
 * masked URL back must be recognised by the caller (see `isMaskedValue()`),
 * because the placeholder is embedded in a longer string.
 */
export function maskUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not an absolute URL — fall back to a textual userinfo strip so a
    // malformed or templated URL cannot leak a password either.
    return decodeMaskPlaceholder(
      url.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@]*@/, `$1${MASKED_SECRET}@`),
    );
  }

  if (parsed.username || parsed.password) {
    parsed.username = MASKED_SECRET;
    parsed.password = '';
  } else if (![...parsed.searchParams.keys()].some(isSecretKey)) {
    // Nothing to hide: return the string exactly as configured rather than the
    // (slightly normalised) result of `URL.toString()`.
    return url;
  }

  // `searchParams.set()` collapses duplicate keys, which is fine for a display
  // copy: the masked response is never written back to `config.yaml`.
  for (const key of [...parsed.searchParams.keys()]) {
    if (isSecretKey(key)) parsed.searchParams.set(key, MASKED_SECRET);
  }

  return decodeMaskPlaceholder(parsed.toString());
}

/** Mask one server config for API output. Returns a copy; never mutates. */
export function maskServerConfig(server: McpServerConfig): McpServerConfig {
  if (server.transport === 'stdio') {
    return { ...server, env: maskRecord(server.env) ?? {}, oauth: maskOAuth(server.oauth) };
  }
  return {
    ...server,
    url: maskUrl(server.url),
    headers: maskRecord(server.headers) ?? {},
    oauth: maskOAuth(server.oauth),
  };
}

/**
 * Mask the whole `mcp:` section for API output.
 *
 * Used by `/api/config`, which returns the full config object and would
 * otherwise expose env values, HTTP Authorization headers and OAuth client
 * secrets even though `/api/mcp/*` masks them.
 */
export function maskMcpSection(mcp: McpSectionConfig | undefined): McpSectionConfig | undefined {
  if (!mcp) return mcp;
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(mcp.servers ?? {})) {
    servers[name] = maskServerConfig(server);
  }
  return { ...mcp, servers };
}

/**
 * True when a value is the mask placeholder, i.e. the client echoed back a
 * masked field instead of supplying a new value. Callers must treat this as
 * "leave the stored secret alone", never as the literal new secret.
 */
export function isMaskedValue(value: unknown): boolean {
  return value === MASKED_SECRET;
}
