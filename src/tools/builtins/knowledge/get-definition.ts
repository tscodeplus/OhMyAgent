// ---------------------------------------------------------------------------
// knowledge_get — read one page: body, citations, outgoing links
// ---------------------------------------------------------------------------

import { z } from 'zod';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { textResult, errorResult } from '../../platform/tool-result.js';
import { zodToTypeBox } from '../../tool-adapter.js';
import { isPageType } from '../../../memory/knowledge/types.js';
import { turnScope } from './turn-scope.js';
import type { KnowledgeService } from '../../../memory/knowledge/service-contract.js';
import type { KnowledgePageRef } from '../../../memory/knowledge/repository.js';

export const knowledgeGetToolCapability: ToolCapabilityDescriptor = {
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

export const knowledgeGetParams = z.object({
  ref: z
    .string()
    .min(1)
    .describe('Page address: `slug`, `page_type/slug` (e.g. topic/power-query), or a page id.'),
  maxChars: z
    .number()
    .int()
    .min(200)
    .max(20000)
    .optional()
    .describe('Body characters to return. Default 4000; the rest is reported as truncated.'),
});

export type KnowledgeGetArgs = z.infer<typeof knowledgeGetParams>;

const DEFAULT_MAX_CHARS = 4000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Turn the single `ref` argument into a repository reference.
 *
 * The address forms are unambiguous once the page-type prefix is checked against
 * the closed set: a uuid is an id, `topic/x` is a typed slug, and anything else
 * (including `notes/2024`, whose prefix is not a page type) is one slug. Trying
 * every form in turn would silently resolve the wrong page once a slug happens
 * to look like an id.
 */
export function parseKnowledgeRef(ref: string): KnowledgePageRef {
  const trimmed = ref.trim();
  if (UUID_PATTERN.test(trimmed)) return { id: trimmed };

  const slash = trimmed.indexOf('/');
  if (slash > 0) {
    const prefix = trimmed.slice(0, slash);
    if (isPageType(prefix)) return { slug: trimmed.slice(slash + 1), pageType: prefix };
  }
  return { slug: trimmed };
}

export function createKnowledgeGetToolDefinition(options: {
  knowledgeService: KnowledgeService;
}): ToolDefinition<KnowledgeGetArgs> {
  return {
    name: 'knowledge_get',
    label: 'Knowledge Get',
    description:
      'Read one knowledge page in full: markdown body, the memories/messages/sessions it cites, and the pages it links to. Use it after knowledge_search to read past the snippet.',
    category: 'memory',
    parametersSchema: zodToTypeBox(knowledgeGetParams),
    capability: knowledgeGetToolCapability,
    deferrable: true,
    execute: async (args, ctx) => {
      const parsed = knowledgeGetParams.safeParse(args);
      if (!parsed.success) {
        return errorResult(
          `Invalid arguments: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
        );
      }

      // A page is addressed within the turn's conversation: its own pages plus
      // `global` ones. Another chat's page is not addressable at all, by slug or
      // by id.
      const { scope, readScope } = turnScope(ctx);

      const ref = parseKnowledgeRef(parsed.data.ref);
      const detail = options.knowledgeService.get(ref, { scope: readScope });
      if (!detail) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No knowledge page found for "${parsed.data.ref}" (scope ${scope}).`,
            },
          ],
          isError: true,
          metadata: { code: 'not_found', scope },
        };
      }

      const maxChars = parsed.data.maxChars ?? DEFAULT_MAX_CHARS;
      const { page } = detail;
      const truncated = page.content.length > maxChars;
      const body = truncated ? page.content.slice(0, maxChars) : page.content;

      const header = [
        `${page.page_type}/${page.slug} — ${page.title}`,
        `version: ${page.version} | status: ${page.status} | body: ${page.content.length} chars${
          truncated ? ` (truncated to ${maxChars})` : ''
        }`,
      ];

      if (detail.sources.length > 0) {
        header.push(
          `sources: ${detail.sources.map((source) => `${source.source_kind}:${source.source_id}`).join(', ')}`,
        );
      }
      if (detail.links.length > 0) {
        header.push(
          `links: ${detail.links
            .map((link) => (link.missing ? `${link.slug} (missing)` : link.slug))
            .join(', ')}`,
        );
      }

      return textResult([...header, '', body].join('\n'), {
        id: page.id,
        slug: page.slug,
        pageType: page.page_type,
        version: page.version,
        scope,
        contentLength: page.content.length,
        truncated,
        sourceCount: detail.sources.length,
        linkCount: detail.links.length,
      });
    },
  };
}
