/**
 * MCP tool visibility — cross-consumer suite (design §12.3 / §16).
 *
 * `PROFILE_TOOLS` is an explicit allow-list, so a dynamically named `mcp__*`
 * tool can only survive through the shared predicate `isMcpToolVisible()`. The
 * design names FOUR consumers of that decision and warns that wiring only some
 * of them "必然失败":
 *
 *   1. src/agent/agent-manager.ts     filterByProfile()       (functional)
 *   2. src/agent/tool-pipeline.ts     Stage 3                 (functional)
 *   3. src/agent/agent-factory.ts     catalog / prompt mirror (cosmetic)
 *   4. src/policy/tool-visibility.ts  isVisible()             (policy layer)
 *
 * Every case below therefore asserts the SAME verdict through all four, so a
 * future edit to one of them cannot silently diverge from the others. The
 * agent-factory and tool-pipeline verdicts are read from real `create()` /
 * `assembleAgentTools()` output (only PromptManager is stubbed, to capture the
 * assembly inputs).
 */

import { describe, it, expect } from 'vitest';
import { ToolVisibilityPolicyImpl } from '../../src/policy/tool-visibility.js';
import type { SkillToolOverrides } from '../../src/policy/tool-visibility.js';
import { AgentManager } from '../../src/agent/agent-manager.js';
import { assembleAgentTools } from '../../src/agent/tool-pipeline.js';
import { createAgentFactory } from '../../src/agent/agent-factory.js';
import { DEFAULT_POLICY_SCOPE } from '../../src/policy/types.js';
import type { AgentPolicyScope } from '../../src/policy/types.js';
import type { McpSectionConfig, McpServerConfig } from '../../src/mcp/types.js';
import type { McpVisibilityConfig } from '../../src/policy/mcp-visibility.js';
import type { AppConfig, AppServices, ToolRegistry } from '../../src/app/types.js';
import type { AgentCreateOptions } from '../../src/agent/agent-factory.js';
import type { PromptManager } from '../../src/prompt/prompt-manager.js';
import type { PromptAssemblyOptions } from '../../src/prompt/types.js';
import type { SkillRegistry } from '../../src/skills/skill-registry.js';
import type { LoadedSkill } from '../../src/skills/skill-loader.js';
import type { ResolvedSkill } from '../../src/skills/skill-router.js';
import { compileSkillContext } from '../../src/skills/skill-compiler.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function stdioServer(name: string, exposure: McpServerConfig['exposure'] = 'deferred') {
  return {
    name,
    enabled: true,
    exposure,
    toolExposure: {},
    toolEnabled: {},
    description: `${name} server`,
    transport: 'stdio' as const,
    command: 'npx',
    args: ['-y', `${name}-mcp`],
    env: {},
    cwd: '',
  };
}

function makeMcpSection(overrides: Partial<McpSectionConfig> = {}): McpSectionConfig {
  return {
    enabled: true,
    connectTimeoutSec: 30,
    requestTimeoutSec: 60,
    maxOutputBytes: 100_000,
    maxConcurrentConnects: 2,
    injectSystemPrompt: true,
    allowServers: [],
    denyServers: [],
    servers: {
      filesystem: stdioServer('filesystem'),
      blocked: stdioServer('blocked'),
    },
    ...overrides,
  };
}

function makeConfig(mcp?: McpSectionConfig): AppConfig {
  return {
    feishu: {
      appId: 'app-id',
      appSecret: 'app-secret',
      verificationToken: '',
      encryptKey: '',
      wsEnabled: true,
    },
    piAi: {
      provider: 'deepseek',
      model: 'deepseek-chat',
      reasoningModel: 'deepseek-reasoner',
      apiKey: 'test-key',
    },
    embedding: {
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'emb-key',
      model: 'test-emb',
      dimension: 1024,
    },
    database: { path: './data/test.db' },
    tools: {
      shellEnabled: true,
      defaultTimeoutMs: 60000,
      maxOutputLength: 12000,
      shellApprovalWhitelist: [],
      shellApprovalMode: 'balanced',
      fileRead: {
        allowedRoots: [],
        deniedPatterns: [],
        allowPathTraversal: false,
        allowHomeReference: false,
      },
    },
    memory: {
      autoRecall: false,
      autoRecallFrequency: 'first',
      autoCapture: false,
      recallTopK: 3,
      captureMaxChars: 500,
      summarizeInterval: 20,
      outputLanguage: 'Auto',
    },
    fallbackModels: [],
    rateLimit: { webhookMaxRequests: 100, webhookWindowMs: 60000 },
    toolSearch: { enabled: 'off' as const },
    smart_agent_team: { enabled: false, max_children: 4 },
    mcp,
  } as unknown as AppConfig;
}

function makeTool(name: string) {
  return {
    name,
    label: name,
    description: `Tool ${name}`,
    parameters: {},
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: null }),
  };
}

function makeRegistry(tools: ReturnType<typeof makeTool>[]): ToolRegistry {
  return {
    register: () => {},
    get: (name: string) => tools.find((t) => t.name === name),
    list: () => tools,
    listAsAgentTools: () => tools,
    has: (name: string) => tools.some((t) => t.name === name),
    unregister: () => {},
    names: () => tools.map((t) => t.name),
  } as unknown as ToolRegistry;
}

const MCP_TOOLS = ['mcp__filesystem__read', 'mcp__blocked__read'];

function makePolicyScope(
  mcpVisibility: McpVisibilityConfig | undefined,
  toolsProfile: AgentPolicyScope['toolsProfile'] = 'standard',
): AgentPolicyScope {
  return { ...DEFAULT_POLICY_SCOPE, toolsProfile, mcpVisibility };
}

/** A skill fixture whose `allowed-tools` are the only tool source for the turn. */
interface SkillFixture {
  id: string;
  allowedTools: string[];
  strict?: boolean;
}

function makeSkill(fixture: SkillFixture): LoadedSkill {
  return {
    manifest: {
      id: fixture.id,
      name: `${fixture.id} skill`,
      description: 'test skill',
      triggers: [fixture.id],
      priority: 0,
      enabled: true,
    },
    promptContent: '',
    tools: {
      allowedTools: fixture.allowedTools,
      ...(fixture.strict ? { surface: 'strict' as const } : {}),
    },
    memoryPolicy: { scopes: [] },
    path: `/tmp/skills/${fixture.id}`,
  } as unknown as LoadedSkill;
}

function makeSkillRegistry(skill: LoadedSkill): SkillRegistry {
  return {
    isLoaded: () => true,
    resolve: () => [
      { skill, matchType: 'trigger', matchedTrigger: skill.manifest.id } as ResolvedSkill,
    ],
    // Real compiler — the production strict-mode decision must be exercised.
    compile: (resolved: ResolvedSkill[]) => compileSkillContext(resolved),
    getSkills: () => [skill],
    getSkillById: (id: string) => (id === skill.manifest.id ? skill : undefined),
  } as unknown as SkillRegistry;
}

/** Capture what agent-factory hands to PromptManager.assemble(). */
function makePromptManagerProbe() {
  const captured: PromptAssemblyOptions[] = [];
  const promptManager = {
    renderTemplate: (template: string) => template,
    registerAgentOverride: () => {},
    assemble: (options: PromptAssemblyOptions) => {
      captured.push(options);
      return {
        systemPrompt: 'stub',
        layers: [],
        tokenCount: 0,
        budgetWarnings: [],
        cacheBreakpoints: [],
      };
    },
  } as unknown as PromptManager;
  return { promptManager, captured };
}

/**
 * The four verdicts, normalised to a boolean-per-MCP-tool map so a test can
 * compare them with one `toEqual`.
 */
interface Verdicts {
  agentManager: Record<string, boolean>;
  toolPipeline: Record<string, boolean>;
  catalog: Record<string, boolean>;
  policy: Record<string, boolean>;
  promptServers: string[];
}

/** Build the verdicts of all four consumers for one config + skill combination. */
function collectVerdicts(opts: {
  config: AppConfig;
  tools: ReturnType<typeof makeTool>[];
  alwaysVisibleTools?: string[];
  toolsProfileOverride?: AgentPolicyScope['toolsProfile'];
  /** Skill-activated turn: ONE fixture drives all four consumers. */
  skill?: SkillFixture;
  /** Overrides handed to the policy consumer alone. */
  policySkillOverrides?: SkillToolOverrides;
}): Verdicts {
  const { config, tools, skill } = opts;
  const registry = makeRegistry(tools);
  const mcpVisibility = config.mcp as McpVisibilityConfig | undefined;
  const effectiveProfile = opts.toolsProfileOverride ?? 'standard';
  const skillStrict = skill?.strict === true;

  // 1. agent-manager (Stage 1 baseline)
  const manager = new AgentManager(
    config,
    [{ id: 'a', name: 'A', tools: { profile: effectiveProfile } }],
    registry,
  );
  const managedTools = manager.resolveTools(manager.getDefault(), undefined, mcpVisibility);

  // 2. tool-pipeline (the array the Agent actually gets)
  const pipeline = assembleAgentTools({
    toolRegistry: registry,
    config,
    effectiveProfile,
    effectiveShellMode: 'full',
    runtimePolicyScope: makePolicyScope(mcpVisibility, effectiveProfile),
    mcpVisibility,
    skillToolsStrict: skillStrict,
    skillAllowedTools: skill?.allowedTools,
    skillDeniedTools: [],
  });

  // 3. agent-factory catalog + mcp_servers prompt mirror
  const { promptManager, captured } = makePromptManagerProbe();
  const factory = createAgentFactory(
    {
      config,
      toolRegistry: registry,
      skillRegistry: skill ? makeSkillRegistry(makeSkill(skill)) : undefined,
    },
    {
      promptManager,
      getServices: () =>
        ({
          mcpManager: { alwaysVisibleTools: () => opts.alwaysVisibleTools ?? [] },
        }) as unknown as AppServices,
    },
  );
  const createOptions: AgentCreateOptions = {};
  if (opts.toolsProfileOverride) createOptions.toolsProfileOverride = opts.toolsProfileOverride;
  if (skill) {
    createOptions.message = `${skill.id} go`;
    createOptions.sessionId = 'lane5-skill-session';
  }
  factory.create(createOptions);
  const assembled = captured[0];
  const catalogNames = (assembled?.availableTools ?? []).map((t) => t.name);
  const promptServers = (assembled?.mcpServers ?? []).map((s) => s.name);

  // 4. policy layer
  const policy = new ToolVisibilityPolicyImpl();
  const policyScope = makePolicyScope(mcpVisibility, effectiveProfile);
  const policyOverrides =
    opts.policySkillOverrides ??
    (skillStrict
      ? { strict: true, allowedTools: skill!.allowedTools, deniedTools: [] }
      : undefined);

  const asMap = (names: string[]): Record<string, boolean> =>
    Object.fromEntries(MCP_TOOLS.map((name) => [name, names.includes(name)]));

  return {
    agentManager: asMap(managedTools.map((t: any) => String(t.name))),
    toolPipeline: asMap(pipeline.tools.map((t: any) => String(t.name))),
    catalog: asMap(catalogNames),
    policy: Object.fromEntries(
      MCP_TOOLS.map((name) => [name, policy.isVisible(name, policyScope, policyOverrides)]),
    ),
    promptServers,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('MCP visibility — the four consumers agree (§12.3)', () => {
  const tools = [...MCP_TOOLS.map(makeTool), makeTool('file_read')];

  it('hides a denied server from every consumer, including the catalog and prompt', () => {
    const config = makeConfig(makeMcpSection({ denyServers: ['blocked'] }));

    const verdicts = collectVerdicts({ config, tools });

    // mcp__filesystem__read is allowed by default, mcp__blocked__read is denied.
    expect(verdicts.agentManager['mcp__blocked__read']).toBe(false);
    expect(verdicts.toolPipeline['mcp__blocked__read']).toBe(false);
    expect(verdicts.catalog['mcp__blocked__read']).toBe(false);
    expect(verdicts.policy['mcp__blocked__read']).toBe(false);
    // … and the allowed server survives in all four.
    expect(verdicts.agentManager['mcp__filesystem__read']).toBe(true);
    expect(verdicts.toolPipeline['mcp__filesystem__read']).toBe(true);
    expect(verdicts.catalog['mcp__filesystem__read']).toBe(true);
    expect(verdicts.policy['mcp__filesystem__read']).toBe(true);
    // The prompt section lists only the callable server.
    expect(verdicts.promptServers).toEqual(['filesystem']);
  });

  it('treats a non-empty allow_servers as an allow-list in every consumer', () => {
    const config = makeConfig(makeMcpSection({ allowServers: ['filesystem'] }));

    const verdicts = collectVerdicts({ config, tools });

    expect(verdicts.agentManager).toEqual({
      mcp__filesystem__read: true,
      mcp__blocked__read: false,
    });
    expect(verdicts.toolPipeline).toEqual(verdicts.agentManager);
    expect(verdicts.catalog).toEqual(verdicts.agentManager);
    expect(verdicts.policy).toEqual(verdicts.agentManager);
    expect(verdicts.promptServers).toEqual(['filesystem']);
  });

  it('hides every MCP tool under the restricted profile in every consumer', () => {
    const config = makeConfig(makeMcpSection());

    const verdicts = collectVerdicts({ config, tools, toolsProfileOverride: 'restricted' });

    expect(verdicts.agentManager).toEqual({
      mcp__filesystem__read: false,
      mcp__blocked__read: false,
    });
    expect(verdicts.toolPipeline).toEqual(verdicts.agentManager);
    expect(verdicts.catalog).toEqual(verdicts.agentManager);
    expect(verdicts.policy).toEqual(verdicts.agentManager);
    expect(verdicts.promptServers).toEqual([]);
  });

  it('keeps the pre-MCP surface byte-for-byte identical when there is no mcp: section', () => {
    const config = makeConfig(undefined);

    const verdicts = collectVerdicts({ config, tools });

    // No mcpVisibility → the predicate is never consulted, so the profile
    // allow-list decides and the dynamic names fall out, exactly as before MCP.
    expect(verdicts.agentManager).toEqual({
      mcp__filesystem__read: false,
      mcp__blocked__read: false,
    });
    expect(verdicts.toolPipeline).toEqual(verdicts.agentManager);
    expect(verdicts.catalog).toEqual(verdicts.agentManager);
    expect(verdicts.policy).toEqual(verdicts.agentManager);
    expect(verdicts.promptServers).toEqual([]);
  });
});

describe('full profile still subtracts MCP denials (M5)', () => {
  const tools = [...MCP_TOOLS.map(makeTool), makeTool('file_read')];

  it('rejects a denied-server tool in every consumer under toolsProfileOverride full', () => {
    const config = makeConfig(makeMcpSection({ denyServers: ['blocked'] }));

    const verdicts = collectVerdicts({ config, tools, toolsProfileOverride: 'full' });

    // Before the fix the `full` shortcuts in agent-manager (Stage 1), the
    // pipeline (Stage 3) and the agent-factory catalog all returned the tool
    // array unfiltered, so `mcp.deny_servers` names leaked into the Layer-1.55
    // catalog and the tool_search deferral pool while the mcp_servers prompt
    // section (which always consults the predicate) correctly omitted them.
    expect(verdicts.agentManager).toEqual({
      mcp__filesystem__read: true,
      mcp__blocked__read: false,
    });
    expect(verdicts.toolPipeline).toEqual(verdicts.agentManager);
    expect(verdicts.catalog).toEqual(verdicts.agentManager);
    expect(verdicts.policy).toEqual(verdicts.agentManager);
    // The prompt section lists only the callable server under `full` too.
    expect(verdicts.promptServers).toEqual(['filesystem']);
  });

  it('keeps allow_servers restrictive under the full profile as well', () => {
    const config = makeConfig(makeMcpSection({ allowServers: ['filesystem'] }));

    const verdicts = collectVerdicts({ config, tools, toolsProfileOverride: 'full' });

    // isMcpToolVisible handles profile + allow + deny in one predicate, so the
    // same deny-only subtraction filter also keeps a non-empty allow_servers
    // from widening under `full`.
    expect(verdicts.agentManager).toEqual({
      mcp__filesystem__read: true,
      mcp__blocked__read: false,
    });
    expect(verdicts.toolPipeline).toEqual(verdicts.agentManager);
    expect(verdicts.catalog).toEqual(verdicts.agentManager);
    expect(verdicts.policy).toEqual(verdicts.agentManager);
  });

  it('does not advertise a denied server through the tool_search deferral pool under full', () => {
    const config = makeConfig(makeMcpSection({ denyServers: ['blocked'] }));
    config.toolSearch = { enabled: 'on' as const };

    const pipeline = assembleAgentTools({
      toolRegistry: makeRegistry(tools),
      config,
      effectiveProfile: 'full',
      effectiveShellMode: 'full',
      runtimePolicyScope: makePolicyScope(config.mcp as McpVisibilityConfig, 'full'),
      mcpVisibility: config.mcp as McpVisibilityConfig,
    });

    // Stage 3 removed the denied tool before Stage 8 ever built the deferral
    // pool, so the deferred catalog — what the tool_search bridge advertises —
    // cannot list it, while the allowed server's tools still defer normally.
    expect(pipeline.tools.map((t: any) => t.name)).not.toContain('mcp__blocked__read');
    const assembly = pipeline.toolSearchAssembly;
    expect(assembly?.activated).toBe(true);
    expect([...(assembly?.deferredCatalog.keys() ?? [])]).not.toContain('mcp__blocked__read');
    expect(assembly?.deferredCatalog.has('mcp__filesystem__read')).toBe(true);
  });

  it('keeps a direct-exposure MCP tool force-visible while deferring the rest (Stage 8 wiring)', () => {
    // t2(o): every earlier pipeline test ran with tool_search off, so the
    // `alwaysVisibleTools → forceVisible` wiring in Stage 8 was never driven.
    const config = makeConfig(makeMcpSection());
    config.toolSearch = { enabled: 'on' as const };

    const pipeline = assembleAgentTools({
      toolRegistry: makeRegistry(tools),
      config,
      effectiveProfile: 'standard',
      effectiveShellMode: 'full',
      runtimePolicyScope: makePolicyScope(config.mcp as McpVisibilityConfig, 'standard'),
      mcpVisibility: config.mcp as McpVisibilityConfig,
      // Production wires `exposure: 'direct'` MCP tools here via the manager.
      alwaysVisibleTools: ['mcp__filesystem__read'],
    });

    const assembly = pipeline.toolSearchAssembly;
    expect(assembly?.activated).toBe(true);
    // Force-visible: stays in the model-facing array un-flagged and out of the
    // deferred catalog the bridge searches.
    const direct = pipeline.tools.find((t: any) => t.name === 'mcp__filesystem__read');
    expect(direct).toBeDefined();
    expect(direct?.deferred).toBeUndefined();
    expect(assembly?.deferredCatalog.has('mcp__filesystem__read')).toBe(false);
    // The non-forced deferrable tool still defers.
    const deferred = pipeline.tools.find((t: any) => t.name === 'mcp__blocked__read');
    expect(deferred?.deferred).toBe(true);
    expect(assembly?.deferredCatalog.has('mcp__blocked__read')).toBe(true);
  });
});

describe('MCP deny is authoritative over a skill allow-list (S6)', () => {
  const tools = [...MCP_TOOLS.map(makeTool), makeTool('file_read')];
  const skillAllowed = ['mcp__*', 'file_read'];

  it('the policy layer denies a denied server even when a skill allow-list grants it', () => {
    const config = makeConfig(makeMcpSection({ denyServers: ['blocked'] }));

    const verdicts = collectVerdicts({
      config,
      tools,
      policySkillOverrides: { allowedTools: skillAllowed },
    });

    // Before the fix the `allowedTools` branch returned true BEFORE the MCP
    // branch was consulted (tool-visibility.ts:161 vs :170).
    expect(verdicts.policy['mcp__blocked__read']).toBe(false);
    expect(verdicts.policy['mcp__filesystem__read']).toBe(true);
  });

  it('the strict skill surface cannot re-open a denied server (pipeline + catalog mirror)', () => {
    const config = makeConfig(makeMcpSection({ denyServers: ['blocked'] }));

    const verdicts = collectVerdicts({
      config,
      tools,
      skill: { id: 'lane5-mcp-skill', allowedTools: skillAllowed, strict: true },
    });

    // Before the fix the strict branch filtered on the skill patterns only and
    // never consulted mcpVisibility, so the denied tool survived in the catalog
    // mirror of Stage 3 inside agent-factory AND in Stage 3 itself.
    expect(verdicts.catalog['mcp__blocked__read']).toBe(false);
    expect(verdicts.toolPipeline['mcp__blocked__read']).toBe(false);
    expect(verdicts.toolPipeline['mcp__filesystem__read']).toBe(true);
    expect(verdicts.policy['mcp__blocked__read']).toBe(false);
    expect(verdicts.policy['mcp__filesystem__read']).toBe(true);
  });

  it('a strict skill still gets the servers it is allowed to use', () => {
    const config = makeConfig(makeMcpSection({ allowServers: ['blocked'] }));

    const verdicts = collectVerdicts({
      config,
      tools,
      skill: { id: 'lane5-mcp-skill', allowedTools: skillAllowed, strict: true },
    });

    expect(verdicts.toolPipeline['mcp__blocked__read']).toBe(true);
    expect(verdicts.toolPipeline['mcp__filesystem__read']).toBe(false);
    expect(verdicts.policy['mcp__blocked__read']).toBe(true);
    expect(verdicts.policy['mcp__filesystem__read']).toBe(false);
  });

  it('leaves the normal (non-MCP) skill allow behaviour untouched', () => {
    const config = makeConfig(makeMcpSection());
    const policy = new ToolVisibilityPolicyImpl();
    const scope = makePolicyScope(config.mcp as McpVisibilityConfig, 'standard');

    // Skill grants a tool the profile hides → allowed (unchanged).
    expect(policy.isVisible('cronjob', scope, { allowedTools: ['cronjob'] })).toBe(true);
    expect(policy.isVisible('cronjob', scope)).toBe(true);
    expect(policy.isVisible('not_a_tool', scope, { allowedTools: ['file_read'] })).toBe(false);
    // Skill deny still wins over its own allow.
    expect(
      policy.isVisible('file_read', scope, {
        allowedTools: ['file_read'],
        deniedTools: ['file_read'],
      }),
    ).toBe(false);
    // Strict mode still narrows to allowedTools ∪ forced core.
    expect(
      policy.isVisible('file_read', scope, { strict: true, allowedTools: ['file_read'] }),
    ).toBe(true);
    expect(
      policy.isVisible('web_search', scope, { strict: true, allowedTools: ['file_read'] }),
    ).toBe(false);
    expect(policy.isVisible('tool_search', scope, { strict: true, allowedTools: [] })).toBe(true);
  });
});

describe('mcp_servers system-prompt section (§12.1)', () => {
  const tools = [...MCP_TOOLS.map(makeTool), makeTool('file_read')];

  it('omits servers the operator denied and servers outside allow_servers', () => {
    const denied = collectVerdicts({
      config: makeConfig(makeMcpSection({ denyServers: ['blocked'] })),
      tools,
    });
    expect(denied.promptServers).toEqual(['filesystem']);

    const listed = collectVerdicts({
      config: makeConfig(makeMcpSection({ allowServers: ['filesystem'] })),
      tools,
    });
    expect(listed.promptServers).toEqual(['filesystem']);
  });

  it('keeps listing every enabled, non-hidden server when nothing restricts it', () => {
    const config = makeConfig(
      makeMcpSection({
        servers: {
          filesystem: stdioServer('filesystem'),
          blocked: stdioServer('blocked'),
          hiddenOne: stdioServer('hiddenOne', 'hidden'),
        },
      }),
    );

    const verdicts = collectVerdicts({ config, tools });

    expect(verdicts.promptServers).toEqual(['filesystem', 'blocked']);
  });

  it('injects nothing when mcp is disabled or system-prompt injection is off', () => {
    const disabledSection = collectVerdicts({
      config: makeConfig(makeMcpSection({ enabled: false })),
      tools,
    });
    expect(disabledSection.promptServers).toEqual([]);

    const noInjection = collectVerdicts({
      config: makeConfig(makeMcpSection({ injectSystemPrompt: false })),
      tools,
    });
    expect(noInjection.promptServers).toEqual([]);
  });
});

describe('catalog deferral annotation mirrors Stage 8 (§7 / E9)', () => {
  const directTool = makeTool('mcp__filesystem__read');

  function buildCatalog(
    toolSearchEnabled: 'off' | 'on',
    alwaysVisibleTools: string[],
  ): Array<{ name: string; snippet: string }> {
    const config = makeConfig(
      makeMcpSection({ servers: { filesystem: stdioServer('filesystem', 'direct') } }),
    );
    config.toolSearch = { enabled: toolSearchEnabled };
    const registry = makeRegistry([directTool, makeTool('web_search')]);
    const { promptManager, captured } = makePromptManagerProbe();
    const factory = createAgentFactory(
      { config, toolRegistry: registry },
      {
        promptManager,
        getServices: () =>
          ({
            mcpManager: { alwaysVisibleTools: () => alwaysVisibleTools },
          }) as unknown as AppServices,
      },
    );

    factory.create();

    return captured[0]?.availableTools ?? [];
  }

  it('does not tell the model to search for a direct-exposure tool it already has', () => {
    const catalog = buildCatalog('on', ['mcp__filesystem__read']);
    const entry = catalog.find((t) => t.name === 'mcp__filesystem__read');

    // Before the fix forceVisibleNames came from extraTools only, so Stage 8
    // kept the tool visible while the catalog still annotated it "[deferred …]".
    expect(entry).toBeDefined();
    expect(entry!.snippet).not.toContain('deferred');
  });

  it('still marks a deferrable tool that is not forced visible', () => {
    const catalog = buildCatalog('on', []);
    const entry = catalog.find((t) => t.name === 'mcp__filesystem__read');

    expect(entry).toBeDefined();
    expect(entry!.snippet).toContain('deferred');
  });

  it('adds no annotation at all when tool search is off', () => {
    const catalog = buildCatalog('off', []);
    const entry = catalog.find((t) => t.name === 'mcp__filesystem__read');

    expect(entry).toBeDefined();
    expect(entry!.snippet).not.toContain('deferred');
  });
});
