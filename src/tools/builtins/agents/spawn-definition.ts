// ---------------------------------------------------------------------------
// v4 ToolDefinition wrapper for the spawn_agent tool
// ---------------------------------------------------------------------------

import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import type { ToolExecutionContext } from '../../platform/tool-context.js';
import type { ToolExecutionResult } from '../../platform/tool-result.js';
import { textResult, errorResult } from '../../platform/tool-result.js';
import { createSpawnAgentTool, type SpawnAgentDeps } from '../spawn-agent-tool.js';

const DEFAULT_TIMEOUT_MS = 300_000;

export const spawnAgentToolCapability: ToolCapabilityDescriptor = {
  category: 'agent',
  readOnly: false,
  readsFiles: false,
  writesFiles: false,
  usesShell: false,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'none',
  approvalDefault: 'mutating',
};

export function createSpawnAgentToolDefinition(deps: SpawnAgentDeps): ToolDefinition {
  const legacyTool = createSpawnAgentTool(deps);

  return {
    name: legacyTool.name,
    label: legacyTool.label,
    description: legacyTool.description,
    category: 'agent',
    parametersSchema: legacyTool.parameters,
    capability: spawnAgentToolCapability,
    execute: async (args, ctx) => {
      // v4 Phase 5: Orchestrator path — triggered when orchestrator is injected
      if (deps.orchestrator) {
        return executeViaOrchestrator(
          deps as SpawnAgentDeps & { orchestrator: NonNullable<SpawnAgentDeps['orchestrator']> },
          args as any,
          ctx,
        );
      }

      // Legacy path: existing code unchanged
      const result = await legacyTool.execute('' as any, args as any);
      return {
        content: (result.content ?? []) as any,
        isError: !result.content?.length,
        metadata: result.details as Record<string, unknown> | undefined,
      };
    },
  };
}

/**
 * v4 Phase 5: Execute a spawn_agent call via the Orchestrator.
 * Creates a proper child AgentRun with inherited policy scope and lifecycle tracking.
 */
async function executeViaOrchestrator(
  deps: SpawnAgentDeps & { orchestrator: NonNullable<SpawnAgentDeps['orchestrator']> },
  args: { persona?: string; task: string; toolsProfile?: string; readOnly?: boolean },
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const parentAgentId = ctx.agentId ?? deps.getParentContext?.()?.agentId ?? 'default';
  const sessionId = ctx.sessionId ?? deps.getParentContext?.()?.sessionId ?? 'default';

  // Resolve persona BEFORE creating AgentRun — avoids orphaned stopped records
  const persona = args.persona || parentAgentId;
  const currentConfig = deps.agentManager.get(persona);
  if (!currentConfig) {
    const available = deps.agentManager.list().map(a => a.id).join(', ');
    return errorResult(`Agent "${persona}" not found. Available agents: ${available}`);
  }

  // Build child scope request from tool args
  const requestedScope = {
    requestedToolsProfile: args.toolsProfile as any,
    requestedReadOnly: args.readOnly ?? false,
  };

  // Call orchestrator to spawn the child agent
  const childRun = await deps.orchestrator.spawnChildAgent({
    parentAgentId,
    sessionId,
    prompt: args.task,
    requestedScope,
  });

  const subConfig = { ...currentConfig };
  // Apply child scope toolsProfile to the sub-agent config
  if (childRun.scope.toolsProfile && subConfig.tools) {
    subConfig.tools = { ...subConfig.tools, profile: childRun.scope.toolsProfile };
  }

  const subAgent = deps.createAgent(subConfig, args.task, {
    sessionId,
    agentId: childRun.agentId,
    policyScope: childRun.scope,
  });

  // Verify the AgentRun exists (thrown if not found)
  deps.orchestrator.getAgentRun(childRun.agentId);

  // F4: Register managed runtime for real abort support
  deps.orchestrator.registerRuntime({
    agentId: childRun.agentId,
    sessionId,
    abort: () => subAgent.abort(),
    waitForIdle: () => subAgent.waitForIdle(),
  });

  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timeoutTimer = setTimeout(() => resolve('timeout'), DEFAULT_TIMEOUT_MS);
    });
    const runPromise = (async (): Promise<'completed'> => {
      await subAgent.prompt(args.task);
      await subAgent.waitForIdle();
      return 'completed';
    })();

    const raceResult = await Promise.race([runPromise, timeoutPromise]);
    if (raceResult === 'timeout') {
      subAgent.abort();
      await subAgent.waitForIdle();
      await deps.orchestrator.finishAgent(childRun.agentId, 'failed', 'timeout');
      return errorResult(`Child agent timed out after ${DEFAULT_TIMEOUT_MS / 1000}s.`);
    }

    // Extract summary from sub-agent state
    const messages = (subAgent.state as any)?.messages ?? [];
    const lastAssistant = [...messages].reverse().find((m: any) => m.role === 'assistant');
    const rawContent = lastAssistant?.content;
    let summary: string;
    if (typeof rawContent === 'string') {
      summary = rawContent.slice(0, 500);
    } else if (Array.isArray(rawContent)) {
      summary = rawContent
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n')
        .slice(0, 500);
    } else {
      summary = '(no output)';
    }

    await deps.orchestrator.finishAgent(childRun.agentId, 'completed', summary);

    return textResult(`[Child agent ${childRun.agentId} completed]\n\n${summary}`);
  } catch (err: any) {
    await deps.orchestrator.finishAgent(childRun.agentId, 'failed', err.message);
    return errorResult(`Child agent failed: ${err.message}`);
  } finally {
    // Cancel the timeout timer (if still armed) so a fast/failed child doesn't
    // keep the event loop alive for the full DEFAULT_TIMEOUT_MS.
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    // F4: Ensure runtime is unregistered even if error handling was skipped
    deps.orchestrator.unregisterRuntime(childRun.agentId);
  }
}
