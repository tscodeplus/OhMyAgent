/**
 * Tool Pipeline
 *
 * Extracted from agent-factory.ts (Phase 8). Assembles the final tool list for
 * an Agent turn through a 6-stage pipeline:
 *
 *   1. Base tool resolution (registry or agent config)
 *   2. Cronjob tool injection
 *   3. Profile-based filtering + computer_use toggle
 *   4. Runtime policy adapter wrapping (AgentToolAdapterImpl)
 *   5. Channel extra tools appending
 *   6. Computer use tool wrapping
 *   7. Spawn agent tool wrapping
 *   8. Tool search assembly (deferred loading)
 *
 * Runs LAST in the Agent create() flow — after model resolution and skill
 * compilation — so all upstream decisions (profile, shell mode, policy scope)
 * are available.
 */

import { Agent } from '@earendil-works/pi-agent-core';
import type {
  AppConfig,
  ToolRegistry,
  ApprovalGate,
  ToolProfileId,
} from '../app/types.js';
import type { ResolvedAgentConfig } from './config-types.js';
import type { AgentManager } from './agent-manager.js';
import { PROFILE_TOOLS } from './agent-manager.js';
import type { ToolExecutionContext } from '../tools/platform/tool-context.js';
import type { ComputerUseHost } from '../computer-use/computer-host.js';
import type { FeishuApprovalClient } from './agent-factory.js';
import type { PolicyCenter } from '../policy/policy-center.js';
import type { AgentPolicyScope } from '../policy/types.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import type { Logger } from 'pino';
import type { AppServices } from '../app/types.js';
import type { DesktopBridgeRegistry } from './desktop-bridge-registry.js';
import { AgentToolAdapterImpl } from '../tools/platform/agent-tool-adapter.js';
import { createCronjobTool } from '../cron/cronjob-tool.js';
import { createComputerUseTool } from '../tools/builtins/computer-use-tool.js';
import { createSpawnAgentToolDefinition } from '../tools/builtins/agents/spawn-definition.js';
import { OffloadStore } from '../runtime-artifacts/offload-store.js';
import { generateId } from '../shared/ids.js';
import { loadConfig as loadToolSearchConfig, assembleTools } from '../tools/tool-search/index.js';

// ─── Profile helper ───

export function shellModeForProfile(profile: ToolProfileId): 'full' | 'read-only' {
  return profile === 'minimal' ? 'read-only' : 'full';
}

// ─── Types ───

/** Callback for creating child agents (spawn_agent tool). */
export type CreateChildAgent = (
  config: ResolvedAgentConfig,
  task: string,
  childOptions: {
    sessionId?: string;
    policyScope?: AgentPolicyScope;
    agentId?: string;
  },
) => Agent;

export interface ToolPipelineOptions {
  // ── Base tools ──
  explicitTools?: any[];
  toolRegistry: ToolRegistry;
  agentConfig?: ResolvedAgentConfig;
  agentManager?: AgentManager;

  // ── Config snapshot ──
  config: AppConfig;

  // ── Session context ──
  chatId?: string;
  channel?: string;
  sessionId?: string;
  runtimeAgentId?: string;

  // ── Resolved profile & policy (computed in agent-factory.ts) ──
  effectiveProfile: ToolProfileId;
  effectiveShellMode: 'full' | 'read-only';
  runtimePolicyScope: AgentPolicyScope;
  computerUseAllowed?: boolean;

  // ── Model metadata (for computer_use context + tool search) ──
  modelProvider?: string;
  modelId?: string;
  modelInput?: string[];
  /** Resolved context window size in tokens (0 if unknown). Used by tool search. */
  contextLength?: number;

  // ── Channel extra tools ──
  extraTools?: any[];

  // ── Computer use ──
  computerUseHost?: ComputerUseHost;
  computerUseImageSender?: (image: { data: string; mimeType: string }) => Promise<string>;
  feishuClient?: FeishuApprovalClient;

  // ── Policy ──
  policyCenter?: PolicyCenter;
  approvalGate?: ApprovalGate;
  getServices?: () => AppServices | undefined;

  // ── Orchestrator ──
  orchestratorFactory?: () => Orchestrator | undefined;
  createChildAgent?: CreateChildAgent;

  // ── Cronjob ──
  cronServiceFactory?: () => any;
  agentName?: string;
  agentId?: string;
  computerUseAllowedFn?: () => boolean;

  // ── Logger ──
  logger?: Logger;
}

export interface ToolPipelineResult {
  tools: any[];
  toolSearchAssembly?: ReturnType<typeof assembleTools>;
}

// ─── Pipeline ───

/**
 * Assemble the final tool list for an Agent turn.
 *
 * Each stage mutates the `tools` array in order. Stages are extracted from
 * the monolithic `create()` method in agent-factory.ts.
 */
export function assembleAgentTools(opts: ToolPipelineOptions): ToolPipelineResult {
  // ── Stage 1: Base tool resolution ──
  let tools = opts.explicitTools ?? opts.toolRegistry.listAsAgentTools();

  if (opts.agentConfig && !opts.explicitTools) {
    tools = opts.agentManager!.resolveTools(opts.agentConfig);
  }

  // ── Stage 2: Cronjob tool ──
  tools = tools.filter((t: any) => t.name !== 'cronjob');
  const cronService = opts.cronServiceFactory?.();
  if (cronService && opts.chatId) {
    try {
      const cronTool = createCronjobTool({
        cronService,
        chatId: opts.chatId,
        channel: opts.channel ?? 'unknown',
        agentName: opts.agentName ?? opts.agentConfig?.name,
        agentId: opts.agentId,
        computerUseAllowed: opts.computerUseAllowedFn ?? (() => tools.some((t: any) => t.name === 'computer_use')),
      });
      tools = [...tools, cronTool];
    } catch {
      opts.logger?.debug('Cronjob tool creation failed — continuing without it');
    }
  }

  // ── Stage 3: Profile-based filtering ──
  const profileAllowedTools = PROFILE_TOOLS[opts.effectiveProfile] ?? PROFILE_TOOLS.standard;
  if (profileAllowedTools[0] !== '*' && !opts.explicitTools) {
    tools = tools.filter((t: any) => profileAllowedTools.includes(t.name) || t.name === 'computer_use');
  }

  if (opts.computerUseAllowed === false) {
    tools = tools.filter((t: any) => t.name !== 'computer_use');
  }

  // ── Stage 3.5: Remove spawn tools when spawn is disabled on this agent ──
  // Placed AFTER profile filtering so even advanced-profile agents must have
  // spawn.enabled explicitly set to true (P0: spawn.enabled gate).
  // Both spawn_agent and plan_and_spawn create child agents — gate them together.
  const spawnEnabled = opts.agentConfig?.spawn?.enabled ?? false;
  if (!spawnEnabled) {
    tools = tools.filter((t: any) => t.name !== 'spawn_agent' && t.name !== 'plan_and_spawn');
  }

  // ── Stage 4: Runtime policy adapter wrapping ──
  const runtimeToolPlatformRegistry = opts.getServices?.()?.toolPlatformRegistry;
  const bridgeRegistry = opts.getServices?.()?.desktopBridgeRegistry;
  if (runtimeToolPlatformRegistry && opts.policyCenter) {
    const runtimeAdapter = new AgentToolAdapterImpl({
      policyCenter: opts.policyCenter,
      getServices: opts.getServices,
      getContextOverrides: () => {
        const overrides: Partial<ToolExecutionContext> = {
          sessionId: opts.sessionId,
          agentId: opts.runtimeAgentId,
          channel: opts.channel,
          chatId: opts.chatId,
          policyScope: opts.runtimePolicyScope,
          approvalAlreadyHandled: !!opts.approvalGate,
        };

        // Inject desktop bridge if one is registered for this session
        if (bridgeRegistry && opts.sessionId && bridgeRegistry.hasBridge(opts.sessionId)) {
          overrides.desktopBridge = {
            callTool: (tool: string, args: unknown, timeoutMs: number) =>
              bridgeRegistry.callTool(opts.sessionId!, tool, args, timeoutMs),
          };
        }

        return overrides;
      },
    });
    tools = tools.map((tool: any) => {
      const def = runtimeToolPlatformRegistry.getDefinition(tool.name);
      return def ? runtimeAdapter.toAgentTool(def) : tool;
    });
  }

  // ── Stage 5: Channel extra tools ──
  // Must run AFTER all filtering so these tools are never removed.
  if (opts.extraTools && opts.extraTools.length > 0) {
    tools = [...tools, ...opts.extraTools];
  }

  // ── Stage 6: Computer use tool wrapping ──
  if (opts.computerUseHost && tools.some((t: any) => t.name === 'computer_use')) {
    const modelInput = Array.isArray(opts.modelInput)
      ? opts.modelInput
      : ['text'];

    const sendComputerUseImage = opts.computerUseImageSender
      ?? (opts.channel === 'feishu' && opts.chatId && opts.feishuClient?.uploadImage && opts.feishuClient?.sendMessage
      ? async (image: { data: string; mimeType: string }) => {
          const buffer = Buffer.from(image.data, 'base64');
          const { imageKey } = await opts.feishuClient!.uploadImage!(buffer, 'message');
          await opts.feishuClient!.sendMessage!({
            receive_id: opts.chatId!,
            receive_id_type: 'chat_id',
            msg_type: 'image',
            content: JSON.stringify({ image_key: imageKey }),
            uuid: generateId(),
          });
          return `Sent to Feishu as image ${imageKey}`;
        }
      : undefined);

    tools = tools.map((tool: any) => tool.name === 'computer_use'
      ? createComputerUseTool(opts.computerUseHost!, () => ({
          sessionPath: opts.sessionId,
          agentId: opts.runtimeAgentId,
          accessMode: opts.effectiveShellMode === 'read-only' ? 'read-only' : 'operate',
          model: {
            provider: opts.modelProvider ?? '',
            id: opts.modelId ?? '',
            input: modelInput as ('text' | 'image' | 'audio')[],
          },
        }), {
          sendImage: sendComputerUseImage,
          policyCenter: opts.policyCenter,
          policyScope: {
            ...opts.runtimePolicyScope,
            computerUseEnabled: opts.runtimePolicyScope.computerUseEnabled && opts.computerUseAllowed !== false,
          },
          approvalAlreadyHandled: !!opts.approvalGate,
          logger: opts.logger,
        })
      : tool);
  }

  // ── Stage 7: Spawn agent tool wrapping ──
  const orchestrator = opts.orchestratorFactory?.();
  if (spawnEnabled && orchestrator && opts.agentManager && opts.logger && tools.some((t: any) => t.name === 'spawn_agent')) {
    // P0: maxParallel unified — reads from resolved agent config first,
    // falls back to global smart_agent_team.max_children.
    const maxParallel = opts.agentConfig?.spawn?.max_parallel
      ?? opts.config.smart_agent_team?.max_children
      ?? 4;
    const spawnDef = createSpawnAgentToolDefinition({
      agentManager: opts.agentManager,
      logger: opts.logger,
      orchestrator,
      maxParallel,
      createAgent: (config, task, childOptions) => {
        const childTools = opts.agentManager!.resolveTools(config)
          .filter((t: any) => t.name !== 'spawn_agent');
        if (!opts.createChildAgent) {
          throw new Error('createChildAgent callback is required for spawn_agent');
        }
        return opts.createChildAgent(config, task, {
          sessionId: childOptions?.sessionId,
          policyScope: childOptions?.policyScope,
          agentId: childOptions?.agentId,
        });
      },
    });
    const spawnAdapter = new AgentToolAdapterImpl({
      policyCenter: opts.policyCenter,
      getServices: opts.getServices,
      getContextOverrides: () => ({
        sessionId: opts.sessionId,
        agentId: opts.runtimeAgentId,
        policyScope: opts.runtimePolicyScope,
        approvalAlreadyHandled: !!opts.approvalGate,
      }),
    });
    tools = tools.map((tool: any) => tool.name === 'spawn_agent'
      ? spawnAdapter.toAgentTool(spawnDef)
      : tool);
  }

  // ── Stage 8: Tool search assembly ──
  // Runs LAST so the deferred catalog references the final policy-wrapped tools.
  let toolSearchAssembly: ReturnType<typeof assembleTools> | undefined;
  try {
    const tsConfig = loadToolSearchConfig(opts.config);

    if (tsConfig.enabled !== 'off') {
      const contextLength = opts.contextLength ?? 0;
      const forceVisible = opts.extraTools?.length
        ? new Set(opts.extraTools.map((t: any) => t.name))
        : undefined;
      toolSearchAssembly = assembleTools(tools, tsConfig, contextLength, forceVisible);

      opts.logger?.debug({
        activated: toolSearchAssembly.activated,
        deferredCount: toolSearchAssembly.deferredCount,
        deferredTokens: toolSearchAssembly.deferredTokens,
      }, 'tool_search assembly');

      if (toolSearchAssembly.activated) {
        opts.logger?.info({
          deferred: toolSearchAssembly.deferredCount,
          deferredTokens: toolSearchAssembly.deferredTokens,
          threshold: toolSearchAssembly.thresholdTokens,
        }, 'tool_search activated');
      }

      tools = toolSearchAssembly.tools;
    }
  } catch (err) {
    opts.logger?.warn({ err }, 'tool_search assembly failed, continuing without tool search');
  }

  return { tools, toolSearchAssembly };
}
