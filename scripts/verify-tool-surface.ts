/**
 * Tool-surface verification script (P3'/P2 design audit).
 *
 * Boots the REAL tool composers (createToolServices + registerV4ToolDefinitions)
 * with the REAL config (loadConfig -> config.yaml) and the REAL agent factory +
 * PromptManager, then creates one agent per profile and reports:
 *   - directly exposed tools (present in the model-facing surface, no deferred flag)
 *   - deferred tools (deferred flag set by the tool-search assembler)
 *   - system-prompt catalog annotation counts
 *
 * Usage: npx tsx scripts/verify-tool-surface.ts
 *
 * Note: extension/channel-registered tools (web_search extension, cronjob,
 * feishu/wechat media senders, cron_* tools) are registered by enabled
 * channels/extensions at bootstrap and are not part of this script's registry;
 * their deferral status follows the same classifier rules (non-core -> deferred).
 */

import { loadConfig } from '../src/app/config.js';
import { createToolServices, registerV4ToolDefinitions } from '../src/app/composers/tool-services.js';
import { createAgentFactory } from '../src/agent/agent-factory.js';
import { PromptManager } from '../src/prompt/prompt-manager.js';
import type { AppConfig, AppServices } from '../src/app/types.js';
import type { ToolProfileId } from '../src/policy/types.js';

const logger: any = {
  info: () => {},
  warn: () => {},
  error: (...a: unknown[]) => console.error('[error]', ...a),
  debug: () => {},
};

const config = loadConfig() as AppConfig;

// ── Stubs: definitions only capture deps at construction; nothing executes ──
const memory: any = {
  memoryRetriever: {},
  memoryWriter: {},
  memorySummarizer: {},
  sessionRepository: {},
  messageRepository: {},
  episodeRepository: {},
  memoryRepository: {},
  embeddingRepository: {},
  memoryLinkRepo: {},
  embeddingClient: {},
  personaAuditService: {},
  memoryDoctor: {},
  memoryChangeCallbacks: [],
};
const policyCenter = {
  evaluateToolCall: () => ({ allowed: true, requiresApproval: false }),
} as any;
const toolsRegistryForResolve: any = { listAsAgentTools: () => [] };
const agentManager: any = {
  resolveTools: () => toolsRegistryForResolve.listAsAgentTools(),
  get: (id: string) =>
    typeof id === 'string' && id.startsWith('verify-') ? { id, spawn: { enabled: true }, model: {}, tools: {} } : undefined,
  getDefault: () => undefined,
};
const agentFactoryStub: any = { create: () => ({}) };
const orchestrator: any = {};
const servicesRef: any = { current: undefined };

const tools = createToolServices({
  config,
  logger,
  memory,
  policyCenter,
  servicesRef,
});

toolsRegistryForResolve.listAsAgentTools = () => tools.toolRegistry.listAsAgentTools();

registerV4ToolDefinitions({
  config,
  logger,
  tools,
  memory,
  policyCenter,
  computerUseHost: undefined, // real bootstrap registers computer_use only when enabled
  agentManager,
  agentFactory: agentFactoryStub,
  orchestrator,
});

// Skill tools (bootstrap registers these into the legacy registry)
// Skipped here: they need skill service deps; restricted excludes them by design.

const promptManager = new PromptManager({ uiLanguage: config.uiLanguage ?? 'zh-CN' });

const factory = createAgentFactory(
  { config, toolRegistry: tools.toolRegistry, toolPlatformRegistry: tools.toolPlatformRegistry, agentManager, logger } as any,
  { promptManager, logger },
);

const allRegistered = tools.toolRegistry.names().sort();
console.log('\nREGISTRY (' + allRegistered.length + '):', allRegistered.join(', '));
console.log('has spawn_agent:', allRegistered.includes('spawn_agent'), ' has plan_and_spawn:', allRegistered.includes('plan_and_spawn'));

const PROFILES: ToolProfileId[] = ['restricted', 'standard', 'full'];

// Tools that the design says are ALWAYS directly exposed when eligible
// (CORE_TOOL_NAMES + the three bridge tools added by the assembler).
const CORE = new Set([
  'file_read', 'file_write', 'file_edit', 'glob', 'grep', 'shell',
  'memory-recall', 'memory-store', 'ask_user_question', 'send_message',
  'tool_search', 'tool_describe', 'tool_call',
]);

for (const profile of PROFILES) {
  const agent = factory.create({
    toolsProfileOverride: profile,
    sessionId: `verify-${profile}`,
  } as any);

  // Spawn-gate variant: per-agent spawn.enabled opens Stage 3.5 for the family
  const agentSpawn = factory.create({
    toolsProfileOverride: profile,
    sessionId: `verify-${profile}-spawn`,
    agentId: `verify-${profile}`,
  } as any);
  const spawnTools = (agentSpawn.state.tools ?? [])
    .map((t: any) => t.name)
    .filter((n: string) => ['spawn_agent', 'plan_and_spawn'].includes(n));

  const all: any[] = agent.state.tools ?? [];
  const direct = all.filter((t) => !t.deferred).map((t) => t.name).sort();
  const deferred = all.filter((t) => t.deferred).map((t) => t.name).sort();

  const sp: string = agent.state.systemPrompt ?? '';
  const catalogEntries = (sp.match(/<tool>/g) ?? []).length;
  const annotated = (sp.match(/\[deferred — discover via tool_search/g) ?? []).length;

  console.log(`\n=== ${profile.toUpperCase()} ===`);
  console.log(`registry surface: ${all.length} tools  (direct ${direct.length} / deferred ${deferred.length})`);
  console.log(`system-prompt catalog: ${catalogEntries} entries, ${annotated} annotated as deferred`);
  console.log(`DIRECT : ${direct.join(', ')}`);
  console.log(`DEFERRED: ${deferred.join(', ')}`);
  console.log(`with agent spawn.enabled=true -> spawn family in surface: [${spawnTools.join(', ')}]`);

  // Invariants from the design doc appendix
  const problems: string[] = [];
  for (const t of direct) {
    if (profile === 'restricted' && ['shell', 'file_write', 'file_edit', 'glob', 'grep', 'send_message'].includes(t)) {
      problems.push(`restricted directly exposes forbidden tool: ${t}`);
    }
  }
  for (const t of all) {
    if (CORE.has(t.name) && profile !== 'restricted') {
      if (!t.deferred && !direct.includes(t.name)) problems.push(`${t.name} should be direct`);
      if (t.deferred) problems.push(`core tool deferred: ${t.name}`);
    }
  }
  if (profile === 'restricted') {
    for (const forbidden of ['shell', 'file_write', 'file_edit', 'download_file', 'web_fetch', 'web_search', 'spawn_agent', 'cronjob', 'skill_create']) {
      if (all.some((t) => t.name === forbidden)) problems.push(`restricted has ineligible tool: ${forbidden}`);
    }
  }
  if (catalogEntries !== all.length) {
    problems.push(`catalog entries (${catalogEntries}) != registry surface (${all.length})`);
  }
  if (annotated !== deferred.length) {
    problems.push(`catalog deferred annotations (${annotated}) != deferred count (${deferred.length})`);
  }
  console.log(problems.length > 0 ? `PROBLEMS:\n  - ${problems.join('\n  - ')}` : 'INVARIANTS OK');
}
