// ---------------------------------------------------------------------------
// v4 ToolDefinition wrapper for the session_search tool
// ---------------------------------------------------------------------------

import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import {
  runSessionSearch,
  SESSION_SEARCH_DESCRIPTION,
  SESSION_SEARCH_PARAMETERS_SCHEMA,
  SESSION_SEARCH_TOOL_LABEL,
  SESSION_SEARCH_TOOL_NAME,
} from './session-search-tool.js';
import type { SessionSearchArgs, SessionSearchToolOptions } from './session-search-tool.js';

export const sessionSearchToolCapability: ToolCapabilityDescriptor = {
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

/**
 * `session_search` — retrieval over raw conversation messages.
 *
 * `deferrable: true` keeps it out of the always-on tool surface: it is a
 * on-demand recall tool, and its schema is only worth its tokens once the
 * model is looking for something that already happened.
 */
export function createSessionSearchToolDefinition(
  options: Omit<SessionSearchToolOptions, 'projectId'>,
): ToolDefinition<SessionSearchArgs> {
  return {
    name: SESSION_SEARCH_TOOL_NAME,
    label: SESSION_SEARCH_TOOL_LABEL,
    description: SESSION_SEARCH_DESCRIPTION,
    category: 'session',
    parametersSchema: SESSION_SEARCH_PARAMETERS_SCHEMA,
    capability: sessionSearchToolCapability,
    deferrable: true,
    execute: async (args, ctx) =>
      runSessionSearch(args, {
        ...options,
        projectId: ctx.projectId,
        logger: options.logger,
      }),
  };
}
