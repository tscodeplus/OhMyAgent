// ---------------------------------------------------------------------------
// Composer — MCP runtime assembly (design §4.2 / §9.1)
// ---------------------------------------------------------------------------
//
// `config.yaml`'s `mcp:` section is the single source of truth (D2), so the
// whole service is conditional on its presence:
//
//   * no `mcp:` section            → no manager at all; every downstream path
//                                    (`AppServices.mcpManager`, the prompt
//                                    section, the profile visibility predicate)
//                                    sees `undefined` and stays exactly as it
//                                    was before MCP existed.
//   * `mcp.enabled: false`         → same: nothing is connected or registered.
//   * `mcp: { … }`                 → a manager whose connect pass runs in the
//                                    background (`ready()` is never awaited
//                                    here — the first Agent build is what waits,
//                                    bounded, per §7.0/§19-5).
//
// The manager owns its OWN `OffloadStore` (D15): the agent factory's instance
// disappears when `memory.offloading.enabled` is false, and MCP output
// truncation must not disappear with it. It still points at the same base
// directory so spills land under the `offload/` root that `file_read` already
// has in its allow-list and that the hygiene sweep reclaims.
//
// Two things live here rather than in the manager, because both need state the
// manager deliberately does not have: the SQLite handle (OAuth credential
// storage, §10.2) and the process-wide tool/capability registries (§11).

import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { createMcpManager, type McpOAuthDeps } from '../../mcp/mcp-manager.js';
import { deleteMcpOAuthCredentials, SqliteMcpOAuthStateStore } from '../../mcp/oauth-store.js';
import {
  createResourceToolDefinitions,
  mcpResourceToolCapability,
  shouldRegisterResourceTools,
} from '../../mcp/resources.js';
import type { McpManager } from '../../mcp/types.js';
import {
  registerToolCapability,
  unregisterToolCapability,
} from '../../policy/tool-capability-registry.js';
import { OffloadStore } from '../../runtime-artifacts/offload-store.js';
import type { ToolPlatformRegistry } from '../../tools/platform/registry.js';
import { loadConfig } from '../config.js';
import type { AppConfig } from '../types.js';

export interface McpServicesDeps {
  config: AppConfig;
  logger: Logger;
  /** v4 registry MCP tools are registered into. */
  toolPlatformRegistry: ToolPlatformRegistry;
  /** Open SQLite handle — the OAuth credential store's backing database. */
  db: Database.Database;
}

export interface McpServices {
  /** Absent when `config.yaml` has no enabled `mcp:` section. */
  mcpManager?: McpManager;
}

/** Assemble the MCP runtime for this process. */
export function createMcpServices(deps: McpServicesDeps): McpServices {
  const section = deps.config.mcp;
  if (!section || !section.enabled) return {};

  const offloadBaseDir =
    deps.config.memory.offloading?.refDir || path.dirname(deps.config.database.path);
  const offloadStore = new OffloadStore(offloadBaseDir);

  const mcpManager = createMcpManager({
    config: section,
    logger: deps.logger,
    toolRegistry: deps.toolPlatformRegistry,
    offloadStore,
    oauth: createOAuthDeps(deps.db),
    // Hot reload hands the manager a freshly loaded section; a config file that
    // currently fails validation leaves the last good section in place rather
    // than tearing the running servers down.
    resolveConfig: () => {
      try {
        return loadConfig().mcp;
      } catch (err) {
        deps.logger.warn({ err }, 'MCP reload: config.yaml could not be re-read — keeping it');
        return undefined;
      }
    },
  });

  registerResourceTools(deps, mcpManager, offloadStore);

  // Fire-and-forget by design: a slow `npx` must not delay the HTTP listen.
  mcpManager.ready().catch((err: unknown) => {
    // `ready()` never rejects — this only guards against a future regression.
    deps.logger.error({ err }, 'MCP initial connect pass rejected unexpectedly');
  });

  return { mcpManager };
}

/**
 * Durable OAuth plumbing for the manager (§10.2).
 *
 * Credentials are stored in plaintext by decision 19-6, exactly like
 * `providerKeys.apiKey` in `config.yaml`. `McpOAuthStateStore` is bound to one
 * server URL upstream, so the manager is handed a resolver rather than a single
 * instance: two servers — or the same name pointing at a new URL — never share
 * a token.
 */
function createOAuthDeps(db: Database.Database): McpOAuthDeps {
  return {
    store: (serverName, serverUrl) => new SqliteMcpOAuthStateStore(db, serverName, serverUrl),
    deleteCredentials: (serverName, serverUrl) => {
      deleteMcpOAuthCredentials(db, serverName, serverUrl);
    },
  };
}

/**
 * Keep the three resource tool definitions in step with the servers that are
 * actually connected (§11).
 *
 * They cannot be registered once at startup: a server only declares the
 * `resources` capability after it connects, which can happen minutes after the
 * gateway listened, and the tool array of an Agent is frozen at `factory.create()`
 * time (§7.0) — so the tools have to appear (and disappear) as the predicate
 * flips. `onToolsChanged` fires repeatedly, hence the idempotent reconcile.
 *
 * The `resources` tool names carry the `mcp__` prefix so the profile visibility
 * predicate admits them in the same places ordinary MCP tools are admitted.
 */
function registerResourceTools(
  deps: McpServicesDeps,
  manager: McpManager,
  offloadStore: OffloadStore,
): void {
  const resources = manager.resources;
  if (!resources) return;

  const definitions = createResourceToolDefinitions({ manager, resources, offload: offloadStore });
  let registered = false;

  const reconcile = (): void => {
    const should = shouldRegisterResourceTools(manager);
    if (should === registered) return;
    registered = should;

    for (const definition of definitions) {
      if (should) {
        deps.toolPlatformRegistry.registerDefinition(definition);
        registerToolCapability(definition.name, mcpResourceToolCapability);
      } else {
        deps.toolPlatformRegistry.unregister(definition.name);
        unregisterToolCapability(definition.name);
      }
    }
    deps.logger.info(
      { registered: should, tools: definitions.map((definition) => definition.name) },
      'MCP resource tools reconciled',
    );
  };

  reconcile();
  // The subscription lives as long as the manager does; `stop()` clears it.
  manager.onToolsChanged(reconcile);
}
