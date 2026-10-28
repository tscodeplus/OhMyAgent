// ---------------------------------------------------------------------------
// knowledge_write — create or update a page, with optimistic concurrency
// ---------------------------------------------------------------------------

import { z } from 'zod';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { errorResult, textResult } from '../../platform/tool-result.js';
import type { ToolExecutionResult } from '../../platform/tool-result.js';
import { zodToTypeBox } from '../../tool-adapter.js';
import { KNOWLEDGE_SOURCE_KINDS, PAGE_TYPES } from '../../../memory/knowledge/types.js';
import type {
  KnowledgeService,
  KnowledgeWriteResult,
} from '../../../memory/knowledge/service-contract.js';

/**
 * Writing persistent, shared knowledge is a mutating operation, so this is the
 * one knowledge tool with `approvalDefault: 'mutating'` (matching `file_write`).
 * Declaring `'none'` would be an approval hole in the balanced policy mode: the
 * second line of defence is the closed `pageType` set, the citation check and
 * the version check, not the approval prompt.
 *
 * `category` is `memory` because `ToolCategory` has no `knowledge` member and the
 * page store is the memory layer's curated tier.
 */
export const knowledgeWriteToolCapability: ToolCapabilityDescriptor = {
  category: 'memory',
  readOnly: false,
  readsFiles: false,
  writesFiles: false,
  usesShell: false,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'none',
  approvalDefault: 'mutating',
};

export const knowledgeWriteParams = z.object({
  pageType: z
    .enum(PAGE_TYPES)
    .describe('Page kind. Closed set: entity | project | topic | decision | snippet.'),
  slug: z.string().min(1).describe('Page address within its type, e.g. `power-query`.'),
  title: z.string().min(1).describe('Human title. Must name a subject, not a wish.'),
  content: z
    .string()
    .min(1)
    .describe('Markdown body. `[[slug]]` / `[[page_type/slug]]` become links.'),
  expectedVersion: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'The `version` you read from knowledge_get. Required to overwrite an existing body; a mismatch is refused and returns the current body so you can re-merge.',
    ),
  sources: z
    .array(
      z.object({
        kind: z.enum(KNOWLEDGE_SOURCE_KINDS).describe('memory | message | session'),
        id: z.string().min(1).describe('An id that already exists in that table.'),
      }),
    )
    .min(1)
    .describe(
      'Citations. Every id must exist: memories, messages or sessions you actually saw. A citation that does not resolve refuses the whole write.',
    ),
  tags: z.array(z.string()).optional().describe('Free-form tags for browsing and filtering.'),
  reason: z.string().optional().describe('Why this page is being written or changed.'),
});

export type KnowledgeWriteArgs = z.infer<typeof knowledgeWriteParams>;

/** How much of the current body a conflict hands back before deferring to knowledge_get. */
const CONFLICT_BODY_CHARS = 4000;

export function createKnowledgeWriteToolDefinition(options: {
  knowledgeService: KnowledgeService;
}): ToolDefinition<KnowledgeWriteArgs> {
  return {
    name: 'knowledge_write',
    label: 'Knowledge Write',
    description:
      'Create or update a knowledge page. Every write must cite at least one existing memory/message/session id, and an update must pass the `version` it read (`expectedVersion`) — a mismatch is refused and returns the current body instead of overwriting it.',
    category: 'memory',
    parametersSchema: zodToTypeBox(knowledgeWriteParams),
    capability: knowledgeWriteToolCapability,
    deferrable: true,
    execute: async (args) => {
      const parsed = knowledgeWriteParams.safeParse(args);
      if (!parsed.success) {
        return errorResult(
          `Invalid arguments: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ')}`,
        );
      }

      const input = parsed.data;

      // Create first: that is the honest attempt for a page the caller believes
      // is new. If the slug is taken, the create is refused *before* writing
      // anything and hands back the current body — the caller then decides to
      // update with the version it just learned.
      let result: KnowledgeWriteResult = options.knowledgeService.create(
        {
          pageType: input.pageType,
          slug: input.slug,
          title: input.title,
          content: input.content,
          tags: input.tags,
          sources: input.sources,
          reason: input.reason,
        },
        { actor: 'agent' },
      );

      if (!result.ok && result.code === 'version_conflict' && input.expectedVersion !== undefined) {
        result = options.knowledgeService.update(
          { slug: input.slug, pageType: input.pageType },
          {
            title: input.title,
            content: input.content,
            tags: input.tags,
            sources: input.sources,
            expectedVersion: input.expectedVersion,
            reason: input.reason,
          },
          { actor: 'agent' },
        );
      }

      if (!result.ok) return formatRejection(result);

      const action = result.created ? 'Created' : 'Updated';
      const lines = [
        `${action} ${result.pageType}/${result.slug} (version ${result.version}, status ${result.status}).`,
        `id: ${result.id}`,
      ];
      if (result.status === 'pending') {
        lines.push(
          'This page is pending review: it is not searchable and not injected until approved.',
        );
      }
      if (result.danglingLinks.length > 0) {
        lines.push(
          `Dangling links (recorded, not an error — write those pages later): ${result.danglingLinks.join(', ')}`,
        );
      }

      return textResult(lines.join('\n'), {
        id: result.id,
        slug: result.slug,
        pageType: result.pageType,
        version: result.version,
        status: result.status,
        created: result.created,
        danglingLinks: result.danglingLinks,
      });
    },
  };
}

/**
 * Turn a refusal into text the model can act on.
 *
 * `version_conflict` is *not* an error result: it is a normal retry signal and
 * it carries the current body so the model can re-merge instead of clobbering.
 * Every other refusal means the call itself was wrong, so it is flagged.
 */
function formatRejection(
  result: Extract<KnowledgeWriteResult, { ok: false }>,
): ToolExecutionResult {
  switch (result.code) {
    case 'version_conflict': {
      const body =
        result.currentContent.length > CONFLICT_BODY_CHARS
          ? `${result.currentContent.slice(0, CONFLICT_BODY_CHARS)}\n… (truncated; call knowledge_get for the rest)`
          : result.currentContent;
      return textResult(
        [
          `version_conflict: the page is at version ${result.currentVersion}, not the one you passed.`,
          'Nothing was written. Re-read the page, merge your change into the current body, then retry with',
          `expectedVersion: ${result.currentVersion}.`,
          '',
          'Current content:',
          body,
        ].join('\n'),
        { code: 'version_conflict', currentVersion: result.currentVersion },
      );
    }
    case 'invalid_page_type':
      return errorResult(
        `invalid_page_type: pageType must be one of ${result.allowed.join(', ')}.`,
      );
    case 'unknown_sources': {
      const listed = result.missing.map((source) => `${source.kind}:${source.id}`).join(', ');
      return {
        content: [
          {
            type: 'text' as const,
            text: [
              'unknown_sources: nothing was written.',
              listed
                ? `These citations do not exist: ${listed}.`
                : 'At least one citation is required.',
              'A page may only cite ids that really exist (memory ids from memory-recall, message ids from',
              'session_search, session ids from the current session). Do not invent them.',
            ].join(' '),
          },
        ],
        isError: true,
        metadata: { code: 'unknown_sources', missing: listed },
      };
    }
    case 'admission_rejected':
      return {
        content: [
          {
            type: 'text' as const,
            text: `admission_rejected (${result.reason}): this does not qualify as a knowledge page yet. ${result.detail}`,
          },
        ],
        isError: true,
        metadata: { code: 'admission_rejected', reason: result.reason },
      };
    case 'not_found':
      return {
        content: [
          {
            type: 'text' as const,
            text: `not_found: no knowledge page addresses "${result.slug}". Create it first.`,
          },
        ],
        isError: true,
        metadata: { code: 'not_found', slug: result.slug },
      };
  }
}
