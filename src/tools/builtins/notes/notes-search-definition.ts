// ---------------------------------------------------------------------------
// v4 ToolDefinition wrapper for the notes_search tool
// ---------------------------------------------------------------------------

import type { Logger } from 'pino';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import {
  NOTES_SEARCH_DESCRIPTION,
  NOTES_SEARCH_PARAMETERS_SCHEMA,
  NOTES_SEARCH_TOOL_LABEL,
  NOTES_SEARCH_TOOL_NAME,
  notesScopeContext,
  runNotesSearch,
} from './notes-search-tool.js';
import type { NotesSearchArgs } from './notes-search-tool.js';
import type { NotesService } from '../../../notes/service-contract.js';

/**
 * A read-only retrieval tool.
 *
 * `category: 'memory'` is a filing label, not a claim that the notes layer *is*
 * the memory layer (it is not: separate tables, no injection, no dedup). It is
 * the curated-knowledge tier, and `ToolCategory` has no `notes` member; the
 * category is read by no approval path — only `tool_search`'s listing filter and
 * `registry.getByCategory` — so filing it with the retrieval tools is what puts
 * it where a model looking for "what do I know" would list it.
 */
export const notesSearchToolCapability: ToolCapabilityDescriptor = {
  category: 'memory',
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
 * `notes_search` — retrieval over the reviewed notes library.
 *
 * `deferrable: true` keeps it out of the always-on surface: notes are asked for
 * on a back-reference ("the command you noted last time"), not on every turn, so
 * the schema is only worth its tokens once the model is looking for something
 * that was written down.
 */
export function createNotesSearchToolDefinition(options: {
  notes: NotesService;
  logger?: Pick<Logger, 'debug' | 'warn'>;
}): ToolDefinition<NotesSearchArgs> {
  return {
    name: NOTES_SEARCH_TOOL_NAME,
    label: NOTES_SEARCH_TOOL_LABEL,
    description: NOTES_SEARCH_DESCRIPTION,
    category: 'memory',
    parametersSchema: NOTES_SEARCH_PARAMETERS_SCHEMA,
    capability: notesSearchToolCapability,
    deferrable: true,
    execute: async (args, ctx) =>
      runNotesSearch(args, {
        notes: options.notes,
        logger: options.logger,
        context: notesScopeContext(ctx),
      }),
  };
}
