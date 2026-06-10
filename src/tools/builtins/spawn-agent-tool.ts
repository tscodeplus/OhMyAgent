import { Type } from 'typebox';
import { generateId } from '../../shared/ids.js';
import type { AgentManager } from '../../agent/agent-manager.js';
import type { ResolvedAgentConfig } from '../../agent/config-types.js';
import type { Agent } from '../../pi-mono/agent/agent.js';
import type { AgentTool } from '../../pi-mono/agent/types.js';
import type { Logger } from 'pino';
import type { AgentPolicyScope } from '../../policy/types.js';

export interface SpawnAgentDeps {
  agentManager: AgentManager;
  logger: Logger;
  // Factory to create an Agent instance from a ResolvedAgentConfig
  createAgent: (
    config: ResolvedAgentConfig,
    task: string,
    options?: { sessionId?: string; agentId?: string; policyScope?: AgentPolicyScope },
  ) => Agent;
  // Optional context provider — set up at bootstrap to inject the parent agent's session/agent id
  getParentContext?: () => { sessionId: string; agentId: string } | undefined;
  // v4 Phase 5: Orchestrator for child agent lifecycle management
  orchestrator?: import('../../orchestrator/orchestrator.js').Orchestrator;
}

// Track active sub-agents per parent session for parallel limit enforcement
const activeSubAgents = new Map<string, Set<string>>();
const MAX_PARALLEL = 3;
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

/** @deprecated Use `createSpawnAgentToolDefinition` from `./agents/spawn-definition.js` instead. */
export function createSpawnAgentTool(deps: SpawnAgentDeps): AgentTool<any> {
  return {
    name: 'spawn_agent',
    label: 'Spawn Agent',
    description: 'Create a sub-agent for independent task execution. Use for research or complex multi-step operations.',
    parameters: Type.Object({
      task: Type.String({ description: 'task description for the sub-agent. Be specific and self-contained.' }),
      persona: Type.Optional(Type.String({ description: 'agent ID to use as the sub-agent persona. Must match an existing agent configuration(e.g. "default", "coder", "designer"). If omitted, inherits current agent. Do NOT invent persona names — only use IDs from the agent list.' })),
    }),
    execute: async (
      _toolCallId: string,
      params: unknown,
      _signal?: AbortSignal,
    ) => {
      const { task, persona } = params as { task: string; persona?: string };
      const parentCtx = deps.getParentContext?.();
      const parentSessionId = parentCtx?.sessionId || 'default';
      const currentAgentId = parentCtx?.agentId || 'default';

      // Parallel limit enforcement
      let sessionSubs = activeSubAgents.get(parentSessionId);
      if (!sessionSubs) {
        sessionSubs = new Set();
        activeSubAgents.set(parentSessionId, sessionSubs);
      }
      if (sessionSubs.size >= MAX_PARALLEL) {
        return {
          content: [{ type: 'text', text: `已达到最大并行子任务数 (${MAX_PARALLEL})。请等待当前子任务完成后再试。` }],
          details: {},
        };
      }

      // Resolve persona
      const currentConfig = deps.agentManager.get(currentAgentId);
      const defaultConfig = deps.agentManager.get('default');
      const parentConfig = currentConfig || defaultConfig;
      const targetPersona = persona || currentAgentId || 'default';

      if (!parentConfig) {
        return {
          content: [{ type: 'text', text: '未找到父代理配置，无法创建子任务。' }],
          details: {},
        };
      }

      // Look up the target agent config for spawn
      const targetConfig = deps.agentManager.get(targetPersona) || parentConfig;
      const subConfig: ResolvedAgentConfig = targetConfig;

      const subAgentId = generateId();
      sessionSubs.add(subAgentId);

      try {
        // Create sub-agent instance
        const subAgent = deps.createAgent(subConfig, task);

        // Set timeout race
        const timeoutPromise = new Promise<'timeout'>((resolve) => {
          setTimeout(() => resolve('timeout'), DEFAULT_TIMEOUT_MS);
        });

        // Run sub-agent
        const runPromise = (async (): Promise<'completed'> => {
          await subAgent.prompt(task);
          await subAgent.waitForIdle();
          return 'completed';
        })();

        const raceResult = await Promise.race([runPromise, timeoutPromise]);

        if (raceResult === 'timeout') {
          subAgent.abort();
          // Let the aborted agent settle
          await subAgent.waitForIdle();

          // Extract partial results if any
          const state = subAgent.state as any;
          const messages = state?.messages || [];
          const partialSummary = extractSummary(messages, task, true);

          return {
            content: [{ type: 'text', text: `子任务超时 (${DEFAULT_TIMEOUT_MS / 1000}s)。\n\n部分结果:\n${partialSummary.content}` }],
            details: partialSummary.details,
          };
        }

        // Extract summary from sub-agent messages
        const state = subAgent.state as any;
        const messages = state?.messages || [];
        const summary = extractSummary(messages, task);

        return {
          content: [{ type: 'text', text: summary.content }],
          details: summary.details,
        };
      } catch (err) {
        deps.logger.error({ err, subAgentId, parentSessionId }, '子任务执行失败');
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `子任务执行失败: ${errorMsg}` }],
          details: {},
        };
      } finally {
        sessionSubs.delete(subAgentId);
        if (sessionSubs.size === 0) {
          activeSubAgents.delete(parentSessionId);
        }
      }
    },
  };
}

function extractSummary(
  messages: Array<{ role: string; content: any }>,
  task: string,
  _timedOut?: boolean,
): {
  content: string;
  details: { toolCalls: Array<{ name: string; count: number }>; messageCount: number; truncated: boolean };
} {
  // Extract last assistant message for the main response
  const assistantMessages = messages.filter(m => m.role === 'assistant');
  const lastAssistant = assistantMessages[assistantMessages.length - 1];

  let text = '';
  if (lastAssistant?.content) {
    if (typeof lastAssistant.content === 'string') {
      text = lastAssistant.content;
    } else if (Array.isArray(lastAssistant.content)) {
      text = lastAssistant.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');
    }
  }

  // Truncate to 2000 chars
  const truncated = text.length > 2000;
  if (truncated) {
    text = text.slice(0, 1997) + '...';
  }

  // Count tool calls across all messages
  const toolCallCounts = new Map<string, number>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'toolCall' && block.name) {
          toolCallCounts.set(block.name, (toolCallCounts.get(block.name) || 0) + 1);
        }
      }
    }
  }

  return {
    content: text || `子任务完成。任务: ${task.slice(0, 100)}`,
    details: {
      toolCalls: Array.from(toolCallCounts.entries()).map(([name, count]) => ({ name, count })),
      messageCount: messages.length,
      truncated,
    },
  };
}
