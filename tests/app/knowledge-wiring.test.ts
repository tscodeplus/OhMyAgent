/**
 * The wiring seam the knowledge/session tools depend on (plan §6 K1-3, K2-3).
 *
 * Until this test existed the four definitions were written, tested and listed
 * in `PROFILE_TOOLS` — and still unreachable by the model, because
 * `registerV4ToolDefinitions()` had no database handle and no knowledge
 * service: `MemoryServices` exposed repositories only, `getServices()` was
 * assigned after registration, and the WebUI routes built a *second* service.
 *
 * So these tests assert the registry contents produced by the real composers
 * (`createMemoryServices` → `createToolServices` → `registerV4ToolDefinitions`)
 * rather than the definitions in isolation, and they assert the two off
 * switches the plan specifies: `knowledge.enabled` and
 * `conversation_search.enabled`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryServices } from '../../src/app/composers/memory-services.js';
import type { MemoryServices } from '../../src/app/composers/memory-services.js';
import {
  createToolServices,
  registerV4ToolDefinitions,
} from '../../src/app/composers/tool-services.js';
import type { ToolServices } from '../../src/app/composers/tool-services.js';
import { createSchedulers } from '../../src/app/composers/scheduler-services.js';
import {
  currentKnowledgeCurator,
  setKnowledgeCuratorResolver,
} from '../../src/commands/command-handler.js';
import type { KnowledgeCurator, KnowledgeCurateConfig } from '../../src/memory/knowledge/curate.js';
import { loadConfig, resetConfig, stopConfigWatcher } from '../../src/app/config.js';
import { openDatabase } from '../../src/memory/db.js';
import type { AppConfig, AppServices } from '../../src/app/types.js';

const BASE_ENV = {
  PI_AI_API_KEY: 'sk-main-key',
  PI_AI_PROVIDER: 'agnes',
  PI_AI_MODEL: 'agnes-2.5-flash',
  EMBEDDING_API_KEY: 'sk-embed',
  EMBEDDING_MODEL: 'text-embedding-3-small',
  EMBEDDING_DIMENSION: '1024',
  DATABASE_PATH: ':memory:',
  CONFIG_FILE: '', // skip config.yaml — env-only path
};

const KNOWLEDGE_TOOLS = ['knowledge_search', 'knowledge_get', 'knowledge_write'] as const;

function silentLogger(): AppServices['logger'] {
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => logger,
  };
  return logger as unknown as AppServices['logger'];
}

function makeConfig(mutate?: (config: AppConfig) => void): AppConfig {
  resetConfig();
  const config = loadConfig(BASE_ENV) as AppConfig;
  mutate?.(config);
  return config;
}

/**
 * Run the compose chain and return the registered tool names.
 *
 * Everything the registration path only *captures* (policy center, agent
 * manager, factory, orchestrator) is a stub: those deps are read inside
 * `execute`, never at registration time, so a stub keeps this a wiring test
 * rather than a bootstrap test.
 */
function registeredToolNames(config: AppConfig, memory: MemoryServices): string[] {
  const logger = silentLogger();
  const servicesRef: { current?: AppServices } = {};
  const tools: ToolServices = createToolServices({
    config,
    logger,
    memory,
    policyCenter: {} as never,
    servicesRef,
  });
  registerV4ToolDefinitions({
    config,
    logger,
    tools,
    memory,
    policyCenter: {} as never,
    agentManager: {} as never,
    agentFactory: {} as never,
    orchestrator: {} as never,
  });
  return tools.toolPlatformRegistry.names();
}

afterEach(() => {
  stopConfigWatcher();
  resetConfig();
  // `createSchedulers` registers the curator resolver process-wide; leaving it
  // set would let one test's instance answer another test's `/knowledge curate`.
  setKnowledgeCuratorResolver(() => undefined);
});

describe('knowledge and session tools reach the registry (plan §6 K1-3, K2-3)', () => {
  it('registers all four tools and builds one knowledge service over the shared db', async () => {
    const config = makeConfig();
    const db = openDatabase(':memory:');
    const memory = await createMemoryServices(config, silentLogger(), db);

    // The seam: the composers hand the *same* handle to the tools that the
    // memory layer uses, so no second connection is opened.
    expect(memory.database).toBe(db);
    expect(memory.knowledgeService).toBeDefined();

    const names = registeredToolNames(config, memory);
    for (const name of [...KNOWLEDGE_TOOLS, 'session_search']) {
      expect(names, `missing tool: ${name}`).toContain(name);
    }
  });

  it('leaves the three knowledge tools out when knowledge.enabled is false', async () => {
    const config = makeConfig((cfg) => {
      cfg.knowledge.enabled = false;
    });
    const db = openDatabase(':memory:');
    const memory = await createMemoryServices(config, silentLogger(), db);

    // No service = the layer is off; that absence is the switch the registrar reads.
    expect(memory.knowledgeService).toBeUndefined();

    const names = registeredToolNames(config, memory);
    for (const name of KNOWLEDGE_TOOLS) {
      expect(names, `unexpected tool: ${name}`).not.toContain(name);
    }
    // Conversation search is a separate flag and stays on.
    expect(names).toContain('session_search');
  });

  it('leaves session_search out when conversation_search.enabled is false', async () => {
    const config = makeConfig((cfg) => {
      cfg.conversationSearch.enabled = false;
    });
    const db = openDatabase(':memory:');
    const memory = await createMemoryServices(config, silentLogger(), db);

    const names = registeredToolNames(config, memory);
    expect(names).not.toContain('session_search');
    // The knowledge layer is untouched by that flag.
    expect(names).toContain('knowledge_search');
  });

  // `read.enabled` is the read surface switch (§6 K2-5 switch table). It takes
  // the writes with it: `knowledge_write` without `knowledge_search`/`get` is a
  // one-way door — the model could file a page it can never read back.
  it('leaves all three knowledge tools out when read.enabled is false', async () => {
    const config = makeConfig((cfg) => {
      cfg.knowledge.read.enabled = false;
    });
    const db = openDatabase(':memory:');
    const memory = await createMemoryServices(config, silentLogger(), db);

    // The service still exists — the pages stay readable from the WebUI and
    // `/knowledge`; only the model's tool surface is closed.
    expect(memory.knowledgeService).toBeDefined();

    const names = registeredToolNames(config, memory);
    for (const name of KNOWLEDGE_TOOLS) {
      expect(names, `unexpected tool: ${name}`).not.toContain(name);
    }
    // Neither neighbour is affected: the two switches are independent.
    expect(names).toContain('session_search');
    expect(names).toContain('memory-recall');
  });
});

/**
 * The nightly phase's switch (plan §6 K2-5, entry point 1).
 *
 * `DreamCycle`'s `knowledge_curate` phase is a documented no-op without a
 * curator, so "curation never ran" was one missing constructor argument: these
 * tests read the real composer's output rather than the DreamCycle constructor,
 * because that argument is the thing that was missing.
 */
describe('knowledge curation is wired into the nightly cycle (plan §6 K2-5)', () => {
  let cronDir: string;

  const schedulersFor = (config: AppConfig, memory: MemoryServices) =>
    createSchedulers({
      config,
      logger: silentLogger(),
      db: memory.database,
      memory,
      // Only read when a cron job actually fires or a job ticks; composing is
      // the behaviour under test, so these stay empty.
      cronDeliveryRegistry: {} as never,
      agentService: {} as never,
      modelName: 'test/model',
    });

  /** The curator DreamCycle was constructed with (a private field, read for the assertion). */
  const curatorOf = (dreamCycle: unknown): KnowledgeCurator | undefined =>
    (dreamCycle as { knowledgeCurator?: KnowledgeCurator }).knowledgeCurator;

  afterEach(() => {
    if (cronDir) rmSync(cronDir, { recursive: true, force: true });
  });

  it('passes the curator built from the shared service to DreamCycle', async () => {
    cronDir = mkdtempSync(join(tmpdir(), 'oma-cron-'));
    const config = makeConfig((cfg) => {
      cfg.cron.dataDir = cronDir;
    });
    const db = openDatabase(':memory:');
    const memory = await createMemoryServices(config, silentLogger(), db);

    const { dreamCycle } = schedulersFor(config, memory);
    const curator = curatorOf(dreamCycle);

    expect(curator).toBeDefined();
    // `/knowledge curate` runs this very object — one instance, two triggers.
    expect(currentKnowledgeCurator()).toBe(curator);
  });

  // `curate.model_ref` (empty by default) has exactly one reader: this mapping.
  // It overrides the model on the shared aux config, so the per-provider keys and
  // the fallback chain keep coming from `memory_aux_models`.
  it('maps curate.model_ref onto the aux config the curator calls with', async () => {
    cronDir = mkdtempSync(join(tmpdir(), 'oma-cron-'));
    const config = makeConfig((cfg) => {
      cfg.cron.dataDir = cronDir;
      cfg.knowledge.curate.modelRef = 'deepseek/curate';
    });
    const db = openDatabase(':memory:');
    const memory = await createMemoryServices(config, silentLogger(), db);

    const curator = curatorOf(schedulersFor(config, memory).dreamCycle);
    const curatorConfig = (curator as unknown as { deps: { config: KnowledgeCurateConfig } }).deps
      .config;

    expect(curatorConfig.auxConfig?.modelRef).toBe('deepseek/curate');
    // Default: the shared chain is used as-is.
    expect(memory.auxModelConfig.modelRef).not.toBe('deepseek/curate');
  });

  it('wires nothing when knowledge.enabled is false, so the phase stays inert', async () => {
    cronDir = mkdtempSync(join(tmpdir(), 'oma-cron-'));
    const config = makeConfig((cfg) => {
      cfg.cron.dataDir = cronDir;
      cfg.knowledge.enabled = false;
    });
    const db = openDatabase(':memory:');
    const memory = await createMemoryServices(config, silentLogger(), db);

    const { dreamCycle } = schedulersFor(config, memory);

    expect(memory.knowledgeService).toBeUndefined();
    expect(curatorOf(dreamCycle)).toBeUndefined();
    // No curator to resolve: `/knowledge curate` answers "not wired".
    expect(currentKnowledgeCurator()).toBeUndefined();
  });
});
