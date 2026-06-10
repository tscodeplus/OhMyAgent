// ---------------------------------------------------------------------------
// v4 ToolDefinition for the ask_user_question tool
// ---------------------------------------------------------------------------

import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { textResult } from '../../platform/tool-result.js';

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

export function createAskUserQuestionToolDefinition(): ToolDefinition {
  return {
    name: 'ask_user_question',
    label: 'Ask User Question',
    description: 'Ask the user a question with optional multiple-choice options.',
    category: 'session',
    parametersSchema: AskUserQuestionParams,
    capability: askUserQuestionCapability,
    execute: async (args: AskUserQuestionArgs, _ctx) => {
      const { question, options } = args;
      let formatted = `[User interaction required] ${question}`;
      if (options && options.length > 0) {
        const choices = options
          .map((opt, i) => `${i + 1}. ${opt}`)
          .join('\n');
        formatted += `\n\nOptions:\n${choices}`;
      }
      return textResult(formatted);
    },
  };
}
