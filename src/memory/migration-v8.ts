/**
 * Migration v8: create `mcp_oauth_credentials` for MCP OAuth state.
 *
 * One row per (server name, server URL) pair, matching upstream
 * `McpOAuthProvider` semantics: the same URL under two names logs in twice,
 * one name with one URL shares a single login (see MyDocs/MCP_INTEGRATION_DESIGN.md
 * §10.2).
 *
 * SECURITY: `client_secret`, `access_token` and `refresh_token` are stored in
 * plaintext. This is an accepted, documented limitation (§10.2 / decision 19-6)
 * — it matches how `providerKeys.apiKey` is already stored in `config.yaml` for
 * the single-user gateway this project targets. The API layer never echoes
 * tokens back (`McpServerView.oauth` is a boolean). Static encryption via an
 * `OHMYAGENT_SECRET_KEY` is explicitly out of scope for this integration.
 *
 * Timestamps follow the project-wide convention: TEXT columns whose DEFAULT is
 * epoch milliseconds rendered as a digit string. Read them with `parseEpochMs`
 * from `src/shared/timestamp.ts`, never with `new Date(...)` — the latter
 * returns Invalid Date for that shape.
 *
 * Idempotent: `CREATE TABLE IF NOT EXISTS`, safe to re-run on every startup.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../app/logger.js';

const logger = createLogger();

/**
 * `state_json` is not part of the §10.2 sketch. Upstream's `McpOAuthState`
 * carries `codeVerifier`, `oauthState`, the DCR client metadata and the
 * discovery document, which the sketched columns have no home for; the
 * discrete columns are kept as an inspectable projection of the same state.
 */
const DDL_MCP_OAUTH_CREDENTIALS = `
  CREATE TABLE IF NOT EXISTS mcp_oauth_credentials (
    server_name   TEXT NOT NULL,
    server_url    TEXT NOT NULL,
    client_id     TEXT,
    client_secret TEXT,
    access_token  TEXT,
    refresh_token TEXT,
    expires_at    TEXT,
    scope         TEXT,
    token_type    TEXT,
    state_json    TEXT,
    created_at    TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
    updated_at    TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
    PRIMARY KEY (server_name, server_url)
  )
`;

/**
 * Apply the v8 schema. Failure is logged and swallowed, matching
 * `migrateV7`'s non-fatal convention: a broken OAuth table must not stop the
 * gateway from booting (no `mcp:` section means the table is never touched).
 */
export function migrateV8(db: Database.Database): void {
  try {
    db.exec(DDL_MCP_OAUTH_CREDENTIALS);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '[migration-v8] failed (non-fatal, continuing startup)',
    );
  }
}
