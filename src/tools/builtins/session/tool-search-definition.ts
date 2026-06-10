// ---------------------------------------------------------------------------
// v4 ToolDefinition for tool_search — introspect registered tools
// ---------------------------------------------------------------------------

import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import type { ToolExecutionContext } from '../../platform/tool-context.js';
import { textResult, errorResult } from '../../platform/tool-result.js';
import { buildCatalog, searchCatalog } from '../../tool-search/bm25.js';

export const toolSearchToolCapability: ToolCapabilityDescriptor = {
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

export function createToolSearchToolDefinition(): ToolDefinition {
  return {
    name: 'tool_search',
    label: 'Tool Search',
    description:
      'Search available tools by name, label, description, or category.',
    category: 'session',
    parametersSchema: Type.Object({
      query: Type.Optional(
        Type.String({
          description:
            'Search query to match against tool name, label, or description (case-insensitive substring match)',
        }),
      ),
      category: Type.Optional(
        Type.String({
          description: 'Filter tools by category(e.g. "file", "web", "shell", "session")',
        }),
      ),
    }),
    capability: toolSearchToolCapability,
    execute: async (
      args: { query?: string; category?: string },
      ctx: ToolExecutionContext,
    ) => {
      const registry = ctx.services.toolPlatformRegistry;
      if (!registry) {
        return errorResult('Tool platform registry is not available.');
      }

      let tools = registry.listDefinitions();

      // Filter by category
      if (args.category) {
        const cat = args.category.toLowerCase();
        tools = tools.filter((t) => t.category.toLowerCase() === cat);
      }

      // Filter by query using BM25 ranking
      if (args.query) {
        const catalog = buildCatalog(
          tools.map((t) => ({
            name: t.name,
            label: t.label,
            description: t.description,
            category: t.category,
          })),
        );
        const matched = searchCatalog(catalog, args.query, 20);

        if (matched.length === 0) {
          return textResult('No tools found matching the given criteria.');
        }

        const lines = matched.map((m) => {
          const def = tools.find((td) => td.name === m.name);
          const readOnly = def?.capability?.readOnly ? 'yes' : 'no';
          return `${m.name}: ${m.label} — ${m.description} (${m.category}, readOnly: ${readOnly})`;
        });

        return textResult(lines.join('\n'));
      }

      // No query: list all tools
      if (tools.length === 0) {
        return textResult('No tools found matching the given criteria.');
      }

      const lines = tools.map((t) => {
        const readOnly = t.capability.readOnly ? 'yes' : 'no';
        return `${t.name}: ${t.label} — ${t.description} (${t.category}, readOnly: ${readOnly})`;
      });

      return textResult(lines.join('\n'));
    },
  };
}
