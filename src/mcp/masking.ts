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

import type { McpOAuthConfig, McpSectionConfig, McpServerConfig } from './types.js';

/** Placeholder substituted for a secret value. */
export const MASKED_SECRET = '••••••';

const SECRET_SUFFIXES = ['token', 'secret', 'key', 'password', 'passwd', 'credential'];
const SECRET_EXACT = ['authorization', 'auth', 'cookie', 'set-cookie', 'proxy-authorization'];

/**
 * True when a config key should be masked.
 *
 * Matches `Authorization` exactly, and anything whose separator-delimited last
 * segment is a secret word (`X-Api-Key`, `GITHUB_TOKEN`, `docs.secret`), plus
 * camelCase spellings with no separator (`apiKey`, `accessToken`).
 *
 * The camelCase branch requires a real lowercase-to-uppercase boundary rather
 * than a plain case-insensitive `endsWith`, so an ordinary word that merely
 * ends in those letters — `MONKEY` — is not masked as if it were a key.
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

/** Mask one server config for API output. Returns a copy; never mutates. */
export function maskServerConfig(server: McpServerConfig): McpServerConfig {
  if (server.transport === 'stdio') {
    return { ...server, env: maskRecord(server.env) ?? {}, oauth: maskOAuth(server.oauth) };
  }
  return { ...server, headers: maskRecord(server.headers) ?? {}, oauth: maskOAuth(server.oauth) };
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
