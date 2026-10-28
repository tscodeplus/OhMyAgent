// ---------------------------------------------------------------------------
// knowledge_search — full-text lookup over active knowledge pages
// ---------------------------------------------------------------------------

import { z } from 'zod';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { textResult, errorResult } from '../../platform/tool-result.js';
import { zodToTypeBox } from '../../tool-adapter.js';
import { PAGE_TYPES } from '../../../memory/knowledge/types.js';
import type { KnowledgeService } from '../../../memory/knowledge/service-contract.js';

export const knowledgeSearchToolCapability: ToolCapabilityDescriptor = {
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

export const knowledgeSearchParams = z.object({
  query: z.string().min(1).describe('What to look for. Chinese and English are both tokenised.'),
  pageType: z
    .enum(PAGE_TYPES)
    .optional()
    .describe('Restrict to one page kind: entity | project | topic | decision | snippet.'),
  tag: z.string().optional().describe('Restrict to pages carrying this exact tag.'),
  limit: z.number().int().min(1).max(20).optional().describe('Maximum hits. Default 6, max 20.'),
});

export type KnowledgeSearchArgs = z.infer<typeof knowledgeSearchParams>;

export function createKnowledgeSearchToolDefinition(options: {
  knowledgeService: KnowledgeService;
}): ToolDefinition<KnowledgeSearchArgs> {
  return {
    name: 'knowledge_search',
    label: 'Knowledge Search',
    description:
      'Search the curated knowledge base for pages (entities, projects, topics, decisions, snippets) written by you or the user. Returns slug, title and a snippet; use knowledge_get to read a page in full. Only confirmed pages are searchable.',
    category: 'memory',
    parametersSchema: zodToTypeBox(knowledgeSearchParams),
    capability: knowledgeSearchToolCapability,
    deferrable: true,
    execute: async (args) => {
      const parsed = knowledgeSearchParams.safeParse(args);
      if (!parsed.success) {
        return errorResult(
          `Invalid arguments: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
        );
      }

      const hits = options.knowledgeService.search(parsed.data.query, {
        pageType: parsed.data.pageType,
        tag: parsed.data.tag,
        limit: parsed.data.limit,
      });

      if (hits.length === 0) {
        return textResult(`No knowledge pages matched "${parsed.data.query}".`, { count: 0 });
      }

      const lines = hits.flatMap((hit, index) => [
        `${index + 1}. ${hit.pageType}/${hit.slug} — ${hit.title}`,
        `   score: ${hit.score.toFixed(2)} | id: ${hit.id}`,
        `   ${hit.snippet}`,
      ]);

      return textResult(lines.join('\n'), {
        count: hits.length,
        hits: hits.map((hit) => ({
          id: hit.id,
          slug: hit.slug,
          pageType: hit.pageType,
          title: hit.title,
          score: hit.score,
        })),
      });
    },
  };
}
