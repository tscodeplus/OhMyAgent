// ---------------------------------------------------------------------------
// MCP OAuth — SQLite-backed `McpOAuthStateStore`
// ---------------------------------------------------------------------------
//
// See MyDocs/MCP_INTEGRATION_DESIGN.md §10 (OAuth flow), §10.2 (credential
// storage) and §19-6 (plaintext credentials are an accepted limitation).
//
// Upstream `McpOAuthProvider` is constructed for one exact server URL and reads
// and writes an opaque `McpOAuthState` through this interface. `McpOAuthState`
// is richer than the credential columns in §10.2 — it also carries the PKCE
// `codeVerifier`, the anti-CSRF `oauthState`, the dynamically registered client
// metadata and the discovered authorization-server document. Those fields live
// in the `state_json` column; the discrete columns (`client_id`,
// `access_token`, `expires_at`, …) are a human-inspectable projection of the
// same state, so an operator can answer "does this server have a token?" with
// plain SQL without parsing JSON.
//
// SECURITY: credentials are stored in plaintext, exactly like
// `providerKeys.apiKey` in `config.yaml` today (§10.2 / decision 19-6). Callers
// must never return these values over the API — `McpServerView.oauth` exposes
// only a boolean.

import type Database from 'better-sqlite3';
import type { McpOAuthState, McpOAuthStateStore, OAuthTokens } from '@earendil-works/pi-mcp/oauth';
import { createLogger } from '../app/logger.js';
import { parseEpochMs } from '../shared/timestamp.js';

const logger = createLogger();

/** One `mcp_oauth_credentials` row, as stored. */
interface McpOAuthCredentialRow {
  server_name: string;
  server_url: string;
  client_id: string | null;
  client_secret: string | null;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
  scope: string | null;
  token_type: string | null;
  state_json: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_SQL = 'SELECT * FROM mcp_oauth_credentials WHERE server_name = ? AND server_url = ?';

const UPSERT_SQL = `
  INSERT INTO mcp_oauth_credentials (
    server_name, server_url, client_id, client_secret, access_token, refresh_token,
    expires_at, scope, token_type, state_json, created_at, updated_at
  ) VALUES (
    @serverName, @serverUrl, @clientId, @clientSecret, @accessToken, @refreshToken,
    @expiresAt, @scope, @tokenType, @stateJson, @now, @now
  )
  ON CONFLICT(server_name, server_url) DO UPDATE SET
    client_id = @clientId,
    client_secret = @clientSecret,
    access_token = @accessToken,
    refresh_token = @refreshToken,
    expires_at = @expiresAt,
    scope = @scope,
    token_type = @tokenType,
    state_json = @stateJson,
    updated_at = @now
`;

/**
 * Persist one server's OAuth state in SQLite.
 *
 * Construct one instance per server URL — upstream's provider is bound to an
 * exact URL, and `(server_name, server_url)` is the table's primary key, so two
 * names pointing at the same URL keep separate logins.
 *
 * For the logout and uninstall paths use {@link deleteMcpOAuthCredentials}.
 */
export class SqliteMcpOAuthStateStore implements McpOAuthStateStore {
  constructor(
    private readonly db: Database.Database,
    private readonly serverName: string,
    private readonly serverUrl: string,
  ) {
    if (!serverName) throw new Error('SqliteMcpOAuthStateStore: serverName must be non-empty');
    if (!serverUrl) throw new Error('SqliteMcpOAuthStateStore: serverUrl must be non-empty');
  }

  /**
   * Read the stored state, or `undefined` when this server never completed a
   * login. The returned object is always owned by this server URL: a row whose
   * `state_json` was written for a different URL can never leak into it.
   */
  load(): McpOAuthState | undefined {
    const row = this.db.prepare(SELECT_SQL).get(this.serverName, this.serverUrl) as
      McpOAuthCredentialRow | undefined;
    if (!row) return undefined;

    if (row.state_json) {
      try {
        const parsed = JSON.parse(row.state_json) as McpOAuthState;
        if (parsed && typeof parsed === 'object') {
          return {
            ...parsed,
            serverUrl:
              typeof parsed.serverUrl === 'string' && parsed.serverUrl
                ? parsed.serverUrl
                : row.server_url,
          };
        }
      } catch (err) {
        // A corrupt JSON payload must not strand a valid login: the discrete
        // columns still hold the tokens, so fall through to them.
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), server: this.serverName },
          '[mcp-oauth] unreadable state_json, falling back to credential columns',
        );
      }
    }
    return stateFromColumns(row);
  }

  /** Insert or replace the whole state for this server URL. */
  save(state: McpOAuthState): void {
    const client = state.clientInformation;
    const tokens = state.tokens;
    const now = String(Date.now());

    this.db.prepare(UPSERT_SQL).run({
      serverName: this.serverName,
      serverUrl: this.serverUrl,
      clientId: client?.client_id ?? null,
      clientSecret: client?.client_secret ?? null,
      accessToken: tokens?.access_token ?? null,
      refreshToken: tokens?.refresh_token ?? null,
      expiresAt: state.tokensExpireAt === undefined ? null : String(state.tokensExpireAt),
      scope: tokens?.scope ?? null,
      tokenType: tokens?.token_type ?? null,
      stateJson: JSON.stringify({ ...state, serverUrl: this.serverUrl }),
      now,
    });
  }
}

/**
 * Drop stored credentials. With `serverUrl` this removes the login for that
 * exact URL (the logout path); without it, every credential row of that server
 * name is removed (the uninstall path with `purge_credentials: true`, where the
 * URL may have changed since the login was made).
 *
 * @returns the number of deleted rows. Idempotent: 0 when nothing matched.
 */
export function deleteMcpOAuthCredentials(
  db: Database.Database,
  serverName: string,
  serverUrl?: string,
): number {
  if (serverUrl === undefined) {
    return db.prepare('DELETE FROM mcp_oauth_credentials WHERE server_name = ?').run(serverName)
      .changes;
  }
  return db
    .prepare('DELETE FROM mcp_oauth_credentials WHERE server_name = ? AND server_url = ?')
    .run(serverName, serverUrl).changes;
}

/** True when at least one credential row exists for the server name. */
export function hasMcpOAuthCredentials(db: Database.Database, serverName: string): boolean {
  return (
    db
      .prepare('SELECT 1 FROM mcp_oauth_credentials WHERE server_name = ? LIMIT 1')
      .get(serverName) !== undefined
  );
}

/**
 * Rebuild the state from the discrete columns alone. Only reached when
 * `state_json` is missing or corrupt; the token columns keep a login usable
 * even then.
 */
function stateFromColumns(row: McpOAuthCredentialRow): McpOAuthState {
  const state: McpOAuthState = { serverUrl: row.server_url };

  if (row.client_id) {
    state.clientInformation = row.client_secret
      ? { client_id: row.client_id, client_secret: row.client_secret }
      : { client_id: row.client_id };
  }

  if (row.access_token) {
    const tokens: OAuthTokens = {
      access_token: row.access_token,
      token_type: row.token_type ?? 'Bearer',
    };
    if (row.refresh_token) tokens.refresh_token = row.refresh_token;
    if (row.scope) tokens.scope = row.scope;
    state.tokens = tokens;
  }

  // `new Date()` cannot parse the digit-string shape this column stores.
  const expiresAt = parseEpochMs(row.expires_at);
  if (expiresAt > 0) state.tokensExpireAt = expiresAt;

  return state;
}
