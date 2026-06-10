// ---------------------------------------------------------------------------
// v4 Tool Platform — adapt ToolDefinition to pi-mono AgentTool
// ---------------------------------------------------------------------------

import type { AgentTool } from '../../pi-mono/agent/types.js';
import type { ToolDefinition } from './tool-definition.js';
import type { ToolExecutionContext } from './tool-context.js';
import type { ToolExecutionResult } from './tool-result.js';
import type { PolicyCenter } from '../../policy/policy-center.js';
import { DEFAULT_POLICY_SCOPE } from '../../policy/types.js';
import type { AppServices } from '../../app/types.js';

/**
 * Runtime hooks executed around every tool invocation.
 * Phase 1 wires the PolicyCenter into beforeExecute.
 */
export interface ToolRuntimeHooks {
  beforeExecute(
    def: ToolDefinition,
    ctx: ToolExecutionContext,
    args: unknown,
  ): Promise<void>;

  afterExecute(
    def: ToolDefinition,
    ctx: ToolExecutionContext,
    result: ToolExecutionResult,
  ): Promise<void>;
}

/** Converts a v4 ToolDefinition into a pi-mono AgentTool. */
export interface AgentToolAdapter {
  toAgentTool(def: ToolDefinition, hooks?: ToolRuntimeHooks): AgentTool<any>;
}

/** Default implementation of AgentToolAdapter. */
export class AgentToolAdapterImpl implements AgentToolAdapter {
  constructor(private deps: {
    policyCenter?: PolicyCenter;
    getServices?: () => AppServices | undefined;
    getContextOverrides?: () => Partial<ToolExecutionContext> | undefined;
  }) {}

  toAgentTool(def: ToolDefinition, hooks?: ToolRuntimeHooks): AgentTool<any> {
    const effectiveHooks = hooks ?? this.createPolicyHooks();
    return {
      name: def.name,
      label: def.label,
      description: def.description,
      parameters: def.parametersSchema as any,

      execute: async (_toolCallId, params, _signal?, _onUpdate?) => {
        // 1. Build ToolExecutionContext
        const ctx: ToolExecutionContext = {
          cwd: process.cwd(),
          policyScope: DEFAULT_POLICY_SCOPE,
          services: this.deps.getServices?.() ?? ({} as AppServices),
          ...this.deps.getContextOverrides?.(),
        };

        // 2. beforeExecute hooks (PolicyCenter gate)
        if (effectiveHooks?.beforeExecute) {
          try {
            await effectiveHooks.beforeExecute(def, ctx, params);
          } catch (err) {
            return {
              content: [{ type: 'text', text: `Tool execution blocked: ${(err as Error).message}` }],
              details: {} as any,
            };
          }
        }

        // 3. Execute the v4 ToolDefinition
        let result: ToolExecutionResult;
        try {
          result = await def.execute(params, ctx);
        } catch (err) {
          result = { content: [{ type: 'text', text: `Tool error: ${(err as Error).message}` }], isError: true };
        }

        // 4. afterExecute hooks (audit/log, non-blocking)
        if (effectiveHooks?.afterExecute) {
          try { await effectiveHooks.afterExecute(def, ctx, result); } catch { /* swallow */ }
        }

        // 5. Convert ToolExecutionResult → AgentToolResult
        return {
          content: result.content.map(c => {
            if (c.type === 'file') {
              return { type: 'text' as const, text: `[File: ${c.path}]` };
            }
            return c as { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
          }),
          details: (result.metadata ?? {}) as any,
        };
      },
    } as AgentTool<any>;
  }

  /** Create hooks that gate every tool execution through PolicyCenter. */
  createPolicyHooks(): ToolRuntimeHooks {
    const { policyCenter } = this.deps;

    return {
      beforeExecute: async (def, ctx, args) => {
        if (!policyCenter) return;
        const decision = await policyCenter.evaluateToolCall({
          toolName: def.name,
          capability: def.capability,
          args,
          sessionId: ctx.sessionId,
          agentId: ctx.agentId,
          channel: ctx.channel,
          policyScope: ctx.policyScope,
        });
        if (decision.resolvedPath) {
          ctx.resolvedPath = decision.resolvedPath;
        }
        if (!decision.allowed && !decision.requiresApproval) {
          throw new Error(decision.reason ?? `Tool "${def.name}" blocked by policy`);
        }
        // F3: requiresApproval must not execute unless the Agent runtime has
        // already run the approval UI hook for this same invocation path.
        if (decision.requiresApproval) {
          if (!ctx.approvalAlreadyHandled) {
            throw new Error(
              `Tool "${def.name}" requires approval before execution.`,
            );
          }
        }
      },
      afterExecute: async () => { /* Phase 2 no-op, Phase 3+ audit */ },
    };
  }
}
