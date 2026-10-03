/**
 * Unit tests for the MCP OAuth credential store
 * (MyDocs/MCP_INTEGRATION_DESIGN.md §10.2, §19-6).
 *
 * Runs against a real in-memory SQLite database with only `migration-v8`
 * applied, so the DDL under test is the table the migration actually creates.
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateV8 } from '../../src/memory/migration-v8.js';
import {
  deleteMcpOAuthCredentials,
  hasMcpOAuthCredentials,
  SqliteMcpOAuthStateStore,
} from '../../src/mcp/oauth-store.js';
import type { McpOAuthState } from '@earendil-works/pi-mcp/oauth';

const SERVER_NAME = 'notion';
const SERVER_URL = 'https://mcp.notion.example/api';

function makeState(overrides: Partial<McpOAuthState> = {}): McpOAuthState {
  return {
    serverUrl: SERVER_URL,
    clientInformation: { client_id: 'client-1', client_secret: 'secret-1' },
    tokens: {
      access_token: 'access-1',
      token_type: 'Bearer',
      refresh_token: 'refresh-1',
      scope: 'read write',
      expires_in: 3600,
    },
    tokensExpireAt: 1_900_000_000_000,
    codeVerifier: 'verifier-1',
    oauthState: 'state-1',
    discovery: { authorizationServerUrl: 'https://auth.example' },
    ...overrides,
  };
}

describe('mcp_oauth_credentials (migration v8)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    migrateV8(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates the table with a (server_name, server_url) primary key', () => {
    const columns = db.pragma('table_info(mcp_oauth_credentials)') as Array<{
      name: string;
      pk: number;
      notnull: number;
      dflt_value: string | null;
    }>;
    const names = columns.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'server_name',
        'server_url',
        'client_id',
        'client_secret',
        'access_token',
        'refresh_token',
        'expires_at',
        'scope',
        'token_type',
        'created_at',
        'updated_at',
      ]),
    );
    const pkColumns = columns.filter((c) => c.pk > 0).map((c) => c.name);
    expect(pkColumns).toEqual(['server_name', 'server_url']);

    // Project convention: epoch ms as a digit string DEFAULT, not datetime().
    const createdAt = columns.find((c) => c.name === 'created_at');
    expect(createdAt?.dflt_value).toContain("strftime('%s','now')");
    expect(createdAt?.dflt_value).not.toContain("datetime('now')");
  });

  it('is idempotent', () => {
    expect(() => migrateV8(db)).not.toThrow();
    expect(() => migrateV8(db)).not.toThrow();
  });

  it('returns undefined before any login', () => {
    const store = new SqliteMcpOAuthStateStore(db, SERVER_NAME, SERVER_URL);
    expect(store.load()).toBeUndefined();
    expect(hasMcpOAuthCredentials(db, SERVER_NAME)).toBe(false);
  });

  it('round-trips the whole state, including the fields without a column', () => {
    const store = new SqliteMcpOAuthStateStore(db, SERVER_NAME, SERVER_URL);
    const state = makeState();

    store.save(state);

    expect(store.load()).toEqual(state);
    expect(hasMcpOAuthCredentials(db, SERVER_NAME)).toBe(true);
  });

  it('projects the state into the documented credential columns', () => {
    const store = new SqliteMcpOAuthStateStore(db, SERVER_NAME, SERVER_URL);
    store.save(makeState());

    const row = db.prepare('SELECT * FROM mcp_oauth_credentials').get() as Record<string, unknown>;
    expect(row.client_id).toBe('client-1');
    expect(row.client_secret).toBe('secret-1');
    expect(row.access_token).toBe('access-1');
    expect(row.refresh_token).toBe('refresh-1');
    expect(row.scope).toBe('read write');
    expect(row.token_type).toBe('Bearer');
    // expires_at is an epoch-ms digit string, readable with parseEpochMs.
    expect(row.expires_at).toBe('1900000000000');
    expect(row.created_at).toMatch(/^\d+$/);
    expect(row.updated_at).toMatch(/^\d+$/);
  });

  it('updates in place on re-save and keeps created_at', () => {
    const store = new SqliteMcpOAuthStateStore(db, SERVER_NAME, SERVER_URL);
    store.save(makeState());
    const created = (
      db.prepare('SELECT created_at FROM mcp_oauth_credentials').get() as {
        created_at: string;
      }
    ).created_at;

    store.save(
      makeState({
        tokens: { access_token: 'access-2', token_type: 'Bearer' },
        tokensExpireAt: undefined,
      }),
    );

    const rows = db
      .prepare(
        'SELECT access_token, refresh_token, expires_at, created_at FROM mcp_oauth_credentials',
      )
      .all() as Array<Record<string, string | null>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].access_token).toBe('access-2');
    expect(rows[0].refresh_token).toBeNull();
    expect(rows[0].expires_at).toBeNull();
    expect(rows[0].created_at).toBe(created);
  });

  it('keeps the same URL under two names as two independent logins', () => {
    new SqliteMcpOAuthStateStore(db, 'alpha', SERVER_URL).save(makeState());
    new SqliteMcpOAuthStateStore(db, 'beta', SERVER_URL).save(
      makeState({ tokens: { access_token: 'beta-token', token_type: 'Bearer' } }),
    );

    expect(new SqliteMcpOAuthStateStore(db, 'alpha', SERVER_URL).load()?.tokens?.access_token).toBe(
      'access-1',
    );
    expect(new SqliteMcpOAuthStateStore(db, 'beta', SERVER_URL).load()?.tokens?.access_token).toBe(
      'beta-token',
    );
  });

  it('rebuilds the state from the columns when state_json is missing', () => {
    const store = new SqliteMcpOAuthStateStore(db, SERVER_NAME, SERVER_URL);
    store.save(makeState());
    db.prepare('UPDATE mcp_oauth_credentials SET state_json = NULL').run();

    expect(store.load()).toEqual({
      serverUrl: SERVER_URL,
      clientInformation: { client_id: 'client-1', client_secret: 'secret-1' },
      tokens: {
        access_token: 'access-1',
        token_type: 'Bearer',
        refresh_token: 'refresh-1',
        scope: 'read write',
      },
      tokensExpireAt: 1_900_000_000_000,
    });
  });

  it('ignores corrupt state_json instead of losing the token', () => {
    const store = new SqliteMcpOAuthStateStore(db, SERVER_NAME, SERVER_URL);
    store.save(makeState());
    db.prepare('UPDATE mcp_oauth_credentials SET state_json = ?').run('{not json');

    expect(store.load()?.tokens?.access_token).toBe('access-1');
  });

  it('deletes one URL for the logout path', () => {
    new SqliteMcpOAuthStateStore(db, SERVER_NAME, SERVER_URL).save(makeState());
    new SqliteMcpOAuthStateStore(db, SERVER_NAME, 'https://other.example/mcp').save(
      makeState({ serverUrl: 'https://other.example/mcp' }),
    );

    expect(deleteMcpOAuthCredentials(db, SERVER_NAME, SERVER_URL)).toBe(1);
    expect(new SqliteMcpOAuthStateStore(db, SERVER_NAME, SERVER_URL).load()).toBeUndefined();
    expect(hasMcpOAuthCredentials(db, SERVER_NAME)).toBe(true);
  });

  it('purges every credential of a server for the uninstall path', () => {
    new SqliteMcpOAuthStateStore(db, SERVER_NAME, SERVER_URL).save(makeState());
    new SqliteMcpOAuthStateStore(db, SERVER_NAME, 'https://other.example/mcp').save(
      makeState({ serverUrl: 'https://other.example/mcp' }),
    );
    new SqliteMcpOAuthStateStore(db, 'unrelated', SERVER_URL).save(makeState());

    expect(deleteMcpOAuthCredentials(db, SERVER_NAME)).toBe(2);
    expect(hasMcpOAuthCredentials(db, SERVER_NAME)).toBe(false);
    expect(hasMcpOAuthCredentials(db, 'unrelated')).toBe(true);
  });

  it('is a no-op when deleting something that is not there', () => {
    expect(deleteMcpOAuthCredentials(db, SERVER_NAME, SERVER_URL)).toBe(0);
    expect(deleteMcpOAuthCredentials(db, SERVER_NAME)).toBe(0);
  });

  it('rejects an empty server name or URL', () => {
    expect(() => new SqliteMcpOAuthStateStore(db, '', SERVER_URL)).toThrow(/serverName/);
    expect(() => new SqliteMcpOAuthStateStore(db, SERVER_NAME, '')).toThrow(/serverUrl/);
  });
});
