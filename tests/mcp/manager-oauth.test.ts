/**
 * MCP OAuth integration tests (MyDocs/MCP_INTEGRATION_DESIGN.md §10, §19-6).
 *
 * The manager is driven against a real in-memory SQLite credential store and an
 * in-memory MCP transport. Nothing here opens a browser, and the only port ever
 * bound is the loopback callback server the feature itself owns — which is what
 * the `manual` flag reports on.
 *
 * The authorization server is stubbed two ways, both upstream-supported seams:
 * the discovery document and client registration are pre-seeded in the store
 * (so `login()` needs no network at all), and `oauth.fetch` answers the token
 * endpoint (so the code exchange does not either).
 */

import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  McpAuthRequiredError,
  type AuthProvider,
  type McpFetch,
  type McpTransport,
} from '@earendil-works/pi-mcp';
import {
  McpOAuthAuthorizationRequiredError,
  type McpOAuthState,
} from '@earendil-works/pi-mcp/oauth';
import { DEFAULT_MCP_SECTION } from '../../src/mcp/config.js';
import {
  createMcpManager,
  type McpManagerDeps,
  type McpManagerLogger,
  type McpOAuthDeps,
  type McpToolRegistryLike,
} from '../../src/mcp/mcp-manager.js';
import {
  deleteMcpOAuthCredentials,
  hasMcpOAuthCredentials,
  SqliteMcpOAuthStateStore,
} from '../../src/mcp/oauth-store.js';
import type {
  McpHttpServerConfig,
  McpManager,
  McpOAuthConfig,
  McpSectionConfig,
  McpServerConfig,
} from '../../src/mcp/types.js';
import { migrateV8 } from '../../src/memory/migration-v8.js';
import { OffloadStore } from '../../src/runtime-artifacts/offload-store.js';
import type { ToolDefinition } from '../../src/tools/platform/tool-definition.js';
import { createTestMcpServer } from './helpers.js';

const SERVER_NAME = 'notion';
const SERVER_URL = 'https://mcp.notion.example/api';
const AUTH_BASE = 'https://auth.example';
const REDIRECT_PORT = 8765;
const OAUTH_STATE = 'state-1';

// ── Fixtures ────────────────────────────────────────────────────────────────

const silentLogger: McpManagerLogger = { debug() {}, info() {}, warn() {}, error() {} };

function createFakeRegistry(): McpToolRegistryLike {
  const definitions = new Map<string, ToolDefinition>();
  return {
    registerDefinition: (def) => definitions.set(def.name, def),
    unregister: (name) => definitions.delete(name),
    has: (name) => definitions.has(name),
  };
}

/** The discovery + registration `login()` would otherwise fetch over the wire. */
function seededState(overrides: Partial<McpOAuthState> = {}): McpOAuthState {
  return {
    serverUrl: SERVER_URL,
    clientInformation: { client_id: 'oma-client' },
    codeVerifier: 'verifier-1',
    oauthState: OAUTH_STATE,
    discovery: {
      authorizationServerUrl: AUTH_BASE,
      authorizationServerMetadata: {
        issuer: AUTH_BASE,
        authorization_endpoint: `${AUTH_BASE}/authorize`,
        token_endpoint: `${AUTH_BASE}/token`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      },
    },
    ...overrides,
  };
}

function httpServer(oauth: Partial<McpOAuthConfig> = {}): McpHttpServerConfig {
  return {
    name: SERVER_NAME,
    enabled: true,
    exposure: 'deferred',
    toolExposure: {},
    toolEnabled: {},
    description: '',
    transport: 'http',
    url: SERVER_URL,
    headers: {},
    oauth: {
      clientId: '',
      clientSecret: '',
      callbackPort: REDIRECT_PORT,
      callbackUrl: '',
      scope: '',
      clientName: 'OhMyAgent',
      authServerMetadataUrl: '',
      ...oauth,
    },
  };
}

/** A transport whose `start()` fails the way a 401 handshake does. */
function failingTransport(error: Error): McpTransport {
  return {
    start: () => Promise.reject(error),
    send: () => Promise.resolve(),
    close: () => Promise.resolve(),
    onMessage: () => () => {},
    onError: () => () => {},
    onClose: () => () => {},
  };
}

interface Harness {
  manager: McpManager;
  db: Database.Database;
  store: SqliteMcpOAuthStateStore;
  /** Bearer provider the manager hands each transport, in connect order. */
  authProviders: Array<AuthProvider | undefined>;
}

interface HarnessOptions {
  server?: McpServerConfig;
  /** Absent → simulate a manager built without §10 wiring. */
  withOAuth?: boolean;
  fetch?: McpFetch;
  /** Default: a transport that cannot connect, so nothing is spawned. */
  transport?: McpManagerDeps['createTransport'];
}

const cleanup: Array<() => void | Promise<void>> = [];

function createHarness(options: HarnessOptions = {}): Harness {
  const db = new Database(':memory:');
  migrateV8(db);
  const offloadBaseDir = mkdtempSync(path.join(tmpdir(), 'mcp-oauth-test-'));

  const authProviders: Array<AuthProvider | undefined> = [];
  const createTransport: NonNullable<McpManagerDeps['createTransport']> =
    options.transport ??
    ((_server, hooks) => {
      authProviders.push(hooks.authProvider);
      return failingTransport(new Error('transport is not scripted in this test'));
    });

  const oauth: McpOAuthDeps | undefined =
    options.withOAuth === false
      ? undefined
      : {
          store: (serverName, serverUrl) => new SqliteMcpOAuthStateStore(db, serverName, serverUrl),
          deleteCredentials: (serverName, serverUrl) => {
            deleteMcpOAuthCredentials(db, serverName, serverUrl);
          },
          ...(options.fetch ? { fetch: options.fetch } : {}),
        };

  const section: McpSectionConfig = {
    ...DEFAULT_MCP_SECTION,
    servers: { [SERVER_NAME]: options.server ?? httpServer() },
  };

  const manager = createMcpManager({
    config: section,
    logger: silentLogger,
    toolRegistry: createFakeRegistry(),
    offloadStore: new OffloadStore(offloadBaseDir),
    createTransport,
    ...(oauth ? { oauth } : {}),
  });

  cleanup.push(async () => {
    await manager.stop();
    db.close();
    rmSync(offloadBaseDir, { recursive: true, force: true });
  });

  return {
    manager,
    db,
    store: new SqliteMcpOAuthStateStore(db, SERVER_NAME, SERVER_URL),
    authProviders,
  };
}

/** A token endpoint that returns a fixed grant and records what it was sent. */
function tokenFetch(tokens: Record<string, unknown>, seen: string[] = []): McpFetch {
  return async (input, init) => {
    seen.push(`${input instanceof URL ? input.href : input} ${String(init?.body ?? '')}`);
    return new Response(JSON.stringify(tokens), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

async function freeTcpPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve, reject) =>
    probe.close((err) => (err ? reject(err) : resolve())),
  );
  return port;
}

/** A loopback listener that will make the callback port unbindable. */
async function occupyTcpPort(): Promise<{ port: number; close(): Promise<void> }> {
  const blocker = net.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const address = blocker.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        blocker.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

afterEach(async () => {
  while (cleanup.length > 0) {
    const dispose = cleanup.pop();
    if (dispose) await dispose();
  }
});

// ── login ───────────────────────────────────────────────────────────────────

describe('McpManager.login', () => {
  it('returns the PKCE authorization URL and reports a listening callback server', async () => {
    const port = await freeTcpPort();
    const harness = createHarness({
      server: httpServer({ callbackPort: port }),
      fetch: tokenFetch({}),
    });
    await harness.store.save(seededState());

    const result = await harness.manager.login(SERVER_NAME);

    expect(result.manual).toBe(false);
    const url = new URL(result.authorizationUrl);
    expect(url.origin + url.pathname).toBe(`${AUTH_BASE}/authorize`);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('oma-client');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${port}/callback`);
    // The anti-CSRF value the pasted callback is later checked against.
    expect(url.searchParams.get('state')).toBe(OAUTH_STATE);

    // The verifier is persisted, so a restart mid-flow can still exchange the code.
    expect((await harness.store.load())?.codeVerifier).toBeTruthy();
  });

  it('reports manual when the redirect target is not on loopback', async () => {
    const harness = createHarness({
      server: httpServer({ callbackUrl: 'https://gateway.example.com/callback' }),
      fetch: tokenFetch({}),
    });
    await harness.store.save(seededState());

    const result = await harness.manager.login(SERVER_NAME);

    expect(result.manual).toBe(true);
    expect(new URL(result.authorizationUrl).searchParams.get('redirect_uri')).toBe(
      'https://gateway.example.com/callback',
    );
  });

  it('falls back to manual when the callback port cannot be bound', async () => {
    const busy = await occupyTcpPort();
    try {
      const harness = createHarness({
        server: httpServer({ callbackUrl: `http://127.0.0.1:${busy.port}/callback` }),
        fetch: tokenFetch({}),
      });
      await harness.store.save(seededState());

      const result = await harness.manager.login(SERVER_NAME);

      expect(result.manual).toBe(true);
      expect(result.authorizationUrl).toContain('code_challenge_method=S256');
    } finally {
      await busy.close();
    }
  });
});

// ── submitCallback ──────────────────────────────────────────────────────────

describe('McpManager.submitCallback', () => {
  it('exchanges a pasted code, persists the tokens and reconnects', async () => {
    const seen: string[] = [];
    const server = await createTestServer();
    const harness = createHarness({
      withOAuth: true,
      fetch: tokenFetch(
        { access_token: 'access-1', token_type: 'Bearer', refresh_token: 'refresh-1' },
        seen,
      ),
      transport: () => server.clientTransport,
    });
    await harness.store.save(seededState());

    await harness.manager.submitCallback(
      SERVER_NAME,
      `http://127.0.0.1:${REDIRECT_PORT}/callback?code=auth-code-1&state=${OAUTH_STATE}`,
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(`${AUTH_BASE}/token`);
    expect(seen[0]).toContain('grant_type=authorization_code');
    expect(seen[0]).toContain('code_verifier=verifier-1');

    const stored = await harness.store.load();
    expect(stored?.tokens?.access_token).toBe('access-1');
    expect(hasMcpOAuthCredentials(harness.db, SERVER_NAME)).toBe(true);

    const state = harness.manager.getServerState(SERVER_NAME);
    expect(state?.state).toBe('connected');
    expect(state?.authRequired).toBe(false);
  });

  it('accepts a bare query string and rejects a foreign state', async () => {
    const harness = createHarness({ withOAuth: true, fetch: tokenFetch({ access_token: 'x' }) });
    await harness.store.save(seededState());

    await expect(
      harness.manager.submitCallback(SERVER_NAME, 'code=abc&state=other'),
    ).rejects.toThrow(/stale or foreign state/);
    await expect(harness.manager.submitCallback(SERVER_NAME, '?code=abc&state=')).rejects.toThrow(
      /stale or foreign state/,
    );
    await expect(
      harness.manager.submitCallback(SERVER_NAME, '?state=' + OAUTH_STATE),
    ).rejects.toThrow(/no authorization code/);
  });

  it('surfaces an error redirect instead of exchanging it', async () => {
    const harness = createHarness({ withOAuth: true, fetch: tokenFetch({}) });
    await harness.store.save(seededState());

    await expect(
      harness.manager.submitCallback(
        SERVER_NAME,
        `?error=access_denied&error_description=user%20said%20no&state=${OAUTH_STATE}`,
      ),
    ).rejects.toThrow(/user said no/);
  });
});

// ── logout ──────────────────────────────────────────────────────────────────

describe('McpManager.logout', () => {
  it('deletes the stored credentials, drops the client and disables the server', async () => {
    const server = await createTestServer();
    const harness = createHarness({ withOAuth: true, transport: () => server.clientTransport });
    await harness.store.save(
      seededState({ tokens: { access_token: 'access-1', token_type: 'Bearer' } }),
    );

    await harness.manager.ready();
    expect(harness.manager.getServerState(SERVER_NAME)?.state).toBe('connected');
    expect(hasMcpOAuthCredentials(harness.db, SERVER_NAME)).toBe(true);

    await harness.manager.logout(SERVER_NAME);

    expect(hasMcpOAuthCredentials(harness.db, SERVER_NAME)).toBe(false);
    expect(await harness.store.load()).toBeUndefined();
    const state = harness.manager.getServerState(SERVER_NAME);
    expect(state?.state).toBe('disabled');
    expect(state?.authRequired).toBe(false);
  });
});

// ── 401 handling ────────────────────────────────────────────────────────────

describe('McpManager 401 handling', () => {
  it('maps a 401 with no credentials to auth_required, not to error', async () => {
    const providers: Array<AuthProvider | undefined> = [];
    const harness = createHarness({
      server: withoutOAuth(),
      withOAuth: true,
      transport: (_server, hooks) => {
        providers.push(hooks.authProvider);
        return failingTransport(new McpAuthRequiredError(new Response(null, { status: 401 }), ''));
      },
    });

    await harness.manager.ready();

    const state = harness.manager.getServerState(SERVER_NAME);
    expect(state?.state).toBe('auth_required');
    expect(state?.authRequired).toBe(true);
    expect(state?.error).toBeTruthy();
    // No `oauth:` block → no bearer provider, which is what leaves a 401 for
    // the user to resolve through the WebUI's login action.
    expect(providers).toEqual([undefined]);
  });

  it('wires the stored tokens into the transport and reports a required login as auth_required', async () => {
    let captured: AuthProvider | undefined;
    const harness = createHarness({
      withOAuth: true,
      transport: (_server, hooks) => {
        captured = hooks.authProvider;
        return failingTransport(new McpOAuthAuthorizationRequiredError());
      },
    });
    await harness.store.save(
      seededState({ tokens: { access_token: 'access-1', token_type: 'Bearer' } }),
    );

    expect(captured).toBeUndefined(); // only built at connect time
    expect(await harness.store.load()).toBeTruthy();

    await harness.manager.ready();

    const state = harness.manager.getServerState(SERVER_NAME);
    expect(state?.state).toBe('auth_required');
    expect(state?.authRequired).toBe(true);
    // Tokens persist across restarts: the provider reads them from SQLite.
    expect(captured).toBeDefined();
    expect(await captured?.token()).toBe('access-1');
  });
});

// ── Not configured ──────────────────────────────────────────────────────────

describe('McpManager OAuth without a store', () => {
  it('fails every OAuth entry point with a clear "not configured" error', async () => {
    const harness = createHarness({ withOAuth: false });

    await expect(harness.manager.login(SERVER_NAME)).rejects.toThrow(/OAuth is not configured/);
    await expect(harness.manager.logout(SERVER_NAME)).rejects.toThrow(/OAuth is not configured/);
    await expect(
      harness.manager.submitCallback(SERVER_NAME, 'http://127.0.0.1:8765/callback?code=x'),
    ).rejects.toThrow(/OAuth is not configured/);
  });

  it('still refuses OAuth for a stdio server', async () => {
    const harness = createHarness({ server: stdioServer(), withOAuth: true });

    await expect(harness.manager.login(SERVER_NAME)).rejects.toThrow(
      /stdio; OAuth applies to HTTP servers only/,
    );
  });

  it('rejects an unknown server before anything else', async () => {
    const harness = createHarness({ withOAuth: true });

    await expect(harness.manager.login('missing-server')).rejects.toThrow(/Unknown MCP server/);
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/** HTTP server without an `oauth:` block — the pre-§10 configuration. */
function withoutOAuth(): McpHttpServerConfig {
  const server = httpServer();
  delete server.oauth;
  return server;
}

/** A stdio server, which has no OAuth surface at all. */
function stdioServer(): McpServerConfig {
  return {
    name: SERVER_NAME,
    enabled: true,
    exposure: 'deferred',
    toolExposure: {},
    toolEnabled: {},
    description: '',
    transport: 'stdio',
    command: 'unused',
    args: [],
    env: {},
    cwd: '',
  };
}

/** A live in-memory MCP server the manager can connect to. */
async function createTestServer() {
  const server = await createTestMcpServer();
  cleanup.push(() => server.close());
  return server;
}
