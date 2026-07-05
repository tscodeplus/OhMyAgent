// ---------------------------------------------------------------------------
// v4 ToolDefinition for the ask_user_question tool
// ---------------------------------------------------------------------------
//
// Interactive flow:
//   LLM calls ask_user_question({ question, options })
//   → tool sends interactive UI via UserQuestionSender
//   → tool awaits UserQuestionStore.create() Promise
//   → user answers (clicks button or types text)
//   → channel callback resolves the Promise
//   → tool returns the answer as a text result
//
// If no UserQuestionSender is available for the channel, the tool falls back
// to formatted text output (current behavior — no waiting).

import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { textResult, errorResult } from '../../platform/tool-result.js';
import { generateId } from '../../../shared/ids.js';
import type { UserQuestionOption, UserQuestionSender } from '../../../agent/user-question-port.js';

export const askUserQuestionCapability: ToolCapabilityDescriptor = {
  category: 'session',
  readOnly: true,
  readsFiles: false,
  writesFiles: false,
  usesShell: false,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'none',
  approvalDefault: 'none',
};

const AskUserQuestionParams = Type.Object({
  question: Type.String(),
  options: Type.Optional(
    Type.Array(Type.String(), { minItems: 2, maxItems: 4 }),
  ),
});

interface AskUserQuestionArgs {
  question: string;
  options?: string[];
}

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

/**
 * Create the ask_user_question ToolDefinition.
 *
 * The tool needs two things from the execution context (ctx.services):
 *   1. userQuestionStore — to create/await a pending question entry
 *   2. getUserQuestionSender — a callback that returns the channel-specific
 *      UserQuestionSender for the active channel/chat
 */
export function createAskUserQuestionToolDefinition(): ToolDefinition {
  return {
    name: 'ask_user_question',
    label: 'Ask User Question',
    description:
      'Ask the user a question with optional multiple-choice options. ' +
      'The agent pauses until the user answers. Options are shown as buttons; ' +
      'the user can also type a free-text answer.',
    category: 'session',
    parametersSchema: AskUserQuestionParams,
    capability: askUserQuestionCapability,
    execute: async (args: AskUserQuestionArgs, ctx) => {
      const { question, options } = args;

      // Resolve services
      const userQuestionStore = ctx.services?.userQuestionStore;
      const getUserQuestionSender = ctx.services?.getUserQuestionSender;

      // Convert string options to UserQuestionOption[]
      const opts: UserQuestionOption[] | undefined = options?.map((label, i) => ({
        label,
        value: `opt_${i}`,
      }));

      // Try to get a channel sender
      const sender: UserQuestionSender | undefined =
        getUserQuestionSender?.(ctx.channel ?? '', ctx.chatId ?? '', ctx.sessionId);

      if (!sender || !userQuestionStore) {
        // ── Fallback: no interactive UI available ──
        let formatted = `[User interaction required] ${question}`;
        if (options && options.length > 0) {
          const choices = options
            .map((opt, i) => `${i + 1}. ${opt}`)
            .join('\n');
          formatted += `\n\nOptions:\n${choices}`;
        }
        return textResult(formatted);
      }

      // ── Interactive path ──
      const requestId = generateId();

      try {
        // Send the question UI (best-effort — if it fails, still try to wait)
        let cardMessageId: string | undefined;
        try {
          cardMessageId = await sender.sendQuestion(
            ctx.chatId!,
            requestId,
            question,
            opts,
          );
        } catch (err) {
          // If we can't send, fall back to text
          let formatted = `[User interaction required] ${question}`;
          if (options && options.length > 0) {
            formatted += '\n\nOptions:\n' + options.map((o, i) => `${i + 1}. ${o}`).join('\n');
          }
          return textResult(formatted);
        }

        // Wait for the user's answer
        const answer = await userQuestionStore.create(
          requestId,
          DEFAULT_TIMEOUT_MS,
          ctx.sessionId,
        );

        // Close/resolve the question UI (best-effort)
        if (sender.closeQuestion) {
          try {
            await sender.closeQuestion(ctx.chatId!, cardMessageId, answer);
          } catch {
            // UI cleanup failure is not a tool failure
          }
        }

        return textResult(answer);
      } catch (err) {
        return errorResult(
          `Failed to ask user question: ${(err as Error).message}`,
        );
      }
    },
  };
}
