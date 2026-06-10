// ---------------------------------------------------------------------------
// v4 ToolDefinition wrapper for the session_summarize tool
// ---------------------------------------------------------------------------

import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { createSessionSummarizeTool } from '../session-summarize-tool.js';
import type { MemorySummarizer } from '../../../memory/memory-summarizer.js';
import type { SessionRepository } from '../../../memory/repositories/session-repository.js';
import type { MessageRepository } from '../../../memory/repositories/message-repository.js';
import type { EpisodeRepository } from '../../../memory/repositories/episode-repository.js';

export const sessionSummarizeToolCapability: ToolCapabilityDescriptor = {
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

export function createSessionSummarizeToolDefinition(options: {
  memorySummarizer: MemorySummarizer;
  sessionRepository: SessionRepository;
  messageRepository: MessageRepository;
  episodeRepository: EpisodeRepository;
}): ToolDefinition {
  const legacyTool = createSessionSummarizeTool(options);

  return {
    name: legacyTool.name,
    label: legacyTool.label,
    description: legacyTool.description,
    category: 'session',
    parametersSchema: legacyTool.parameters,
    capability: sessionSummarizeToolCapability,
    execute: async (args, _ctx) => {
      const result = await legacyTool.execute('' as any, args as any);
      return {
        content: (result.content ?? []) as any,
        isError: !result.content?.length,
        metadata: result.details as Record<string, unknown> | undefined,
      };
    },
  };
}
