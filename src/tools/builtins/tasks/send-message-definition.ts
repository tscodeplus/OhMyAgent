// ---------------------------------------------------------------------------
// v4 ToolDefinition wrapper for the send_message tool
// ---------------------------------------------------------------------------

import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import type { ToolExecutionContext } from '../../platform/tool-context.js';
import { textResult, errorResult } from '../../platform/tool-result.js';

export const sendMessageToolCapability: ToolCapabilityDescriptor = {
  category: 'task',
  readOnly: false,
  readsFiles: false,
  writesFiles: false,
  usesShell: false,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'none',
  approvalDefault: 'none',
};

export const externalSendMessageToolCapability: ToolCapabilityDescriptor = {
  ...sendMessageToolCapability,
  usesNetwork: true,
  approvalDefault: 'high_risk',
};

// ---------------------------------------------------------------------------
// ExternalMessageSender interface
// ---------------------------------------------------------------------------

export interface ExternalMessageSender {
  send(input: {
    channel: 'feishu' | 'telegram' | 'wechat' | 'qq';
    targetId: string;
    content: string;
    kind: 'question' | 'message';
  }): Promise<{ messageId?: string }>;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SendMessageParams = Type.Object({
  toAgentId: Type.String({ description: 'The target agent ID to send the message to' }),
  content: Type.String({ description: 'The message content' }),
  kind: Type.Optional(
    Type.Union([
      Type.Literal('instruction'),
      Type.Literal('status'),
      Type.Literal('result'),
      Type.Literal('question'),
    ], { description: 'Message kind. Default: instruction' }),
  ),
  route: Type.Optional(Type.Union([Type.Literal('internal'), Type.Literal('external')])),
  targetChannel: Type.Optional(Type.Union([
    Type.Literal('feishu'),
    Type.Literal('telegram'),
    Type.Literal('wechat'),
    Type.Literal('qq'),
  ])),
  targetId: Type.Optional(Type.String()),
  externalKind: Type.Optional(Type.Union([Type.Literal('question'), Type.Literal('message')])),
});

interface SendMessageArgs {
  toAgentId: string;
  content: string;
  kind?: 'instruction' | 'status' | 'result' | 'question';
  route?: 'internal' | 'external';
  targetChannel?: 'feishu' | 'telegram' | 'wechat' | 'qq';
  targetId?: string;
  externalKind?: 'question' | 'message';
}

// ---------------------------------------------------------------------------
// ToolDefinition factory
// ---------------------------------------------------------------------------

export function createSendMessageToolDefinition(): ToolDefinition {
  return {
    name: 'send_message',
    label: 'Send Message',
    description:
      'Send a message to another agent or the user. Internal messages ' +
      '(instruction/status/result) do not trigger approval UI. External messages ' +
      '(question) go through policy checks.',
    category: 'task',
    parametersSchema: SendMessageParams,
    capability: sendMessageToolCapability,
    execute: async (args: SendMessageArgs, ctx: ToolExecutionContext) => {
      const orchestrator = ctx.services.orchestrator;
      const policyCenter = ctx.services.policyCenter;

      // Determine route: all kinds default to internal unless route: 'external' is explicitly set.
      const isExternalRoute = args.route === 'external';

      if (!isExternalRoute) {
        // ---- Internal path (existing behavior) ----
        if (!orchestrator) {
          return errorResult('Orchestrator is not available.');
        }

        try {
          await orchestrator.sendMessage({
            fromAgentId: ctx.agentId ?? 'primary',
            toAgentId: args.toAgentId,
            sessionId: ctx.sessionId ?? 'default',
            kind: args.kind ?? 'instruction',
            content: args.content,
          });
          return textResult(`Message sent to agent "${args.toAgentId}".`);
        } catch (err: any) {
          return errorResult(`Failed to send message: ${err.message}`);
        }
      }

      // ---- External path ----
      // Must have targetChannel and targetId
      if (!args.targetChannel || !args.targetId) {
        return errorResult(
          'External send requires targetChannel and targetId fields.',
        );
      }

      // Unsupported channel check (before policy to fail fast)
      const supportedChannels = new Set(['feishu', 'telegram', 'wechat', 'qq']);
      if (!supportedChannels.has(args.targetChannel)) {
        return errorResult(`Unsupported external send channel: ${args.targetChannel}`);
      }

      // Check via PolicyCenter
      if (policyCenter) {
        const decision = await policyCenter.evaluateToolCall({
          toolName: 'send_message',
          capability: externalSendMessageToolCapability,
          args,
          sessionId: ctx.sessionId,
          agentId: ctx.agentId,
          channel: ctx.channel,
          policyScope: ctx.policyScope,
        });

        if (!decision.allowed && !decision.requiresApproval) {
          return errorResult(decision.reason ?? 'External send blocked by policy');
        }

        if (decision.requiresApproval) {
          if (ctx.approvalAlreadyHandled) {
            // The Agent beforeToolCall hook already presented approval UI for
            // this same invocation path. Continue with the approved send.
          } else {
            return errorResult(
              'External send requires user approval before execution.',
            );
          }
        }
      }

      // Approved (or no policy center): send via external message sender
      const sender = ctx.services.externalMessageSender;
      if (!sender) {
        return errorResult('External message sender is not configured.');
      }

      try {
        await sender.send({
          channel: args.targetChannel,
          targetId: args.targetId,
          content: args.content,
          kind: args.externalKind ?? 'message',
        });
        return textResult(
          `External message sent via ${args.targetChannel} to "${args.targetId}".`,
        );
      } catch (err: any) {
        return errorResult(`Failed to send external message: ${err.message}`);
      }
    },
  };
}
