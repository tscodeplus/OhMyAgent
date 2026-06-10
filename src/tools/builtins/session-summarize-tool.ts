import { z } from 'zod';
import { zodToTypeBox } from '../tool-adapter.js';
import type { MemorySummarizer } from '../../memory/memory-summarizer.js';
import type { SessionRepository } from '../../memory/repositories/session-repository.js';
import type { MessageRepository } from '../../memory/repositories/message-repository.js';
import type { EpisodeRepository } from '../../memory/repositories/episode-repository.js';
import type { AgentTool } from '../../pi-mono/agent/types.js';
import { i18n } from '../../i18n/index.js';

/** @deprecated Use `createSessionSummarizeToolDefinition` from `./session/definition.js` instead. */
export function createSessionSummarizeTool(options: {
  memorySummarizer: MemorySummarizer;
  sessionRepository: SessionRepository;
  messageRepository: MessageRepository;
  episodeRepository: EpisodeRepository;
}): AgentTool<any> {
  const schema = z.object({
    reason: z.string().optional()
      .describe('Brief reason for summarization (e.g., "topic concluded", "task completed")'),
  });

  return {
    name: 'summarize-session',
    label: 'Session Summarize',
    description:
      'Summarize the current conversation and save it to long-term memory. ' +
      'Call this when a topic discussion or task has reached a natural conclusion, ' +
      'or when the user has shared several pieces of information that should be preserved together.',
    parameters: zodToTypeBox(schema),
    execute: async (callId: string, args: { reason?: string }) => {
      try {
        // Find the most recently active session (with messages)
        const recentSessions = options.sessionRepository.listRecent?.(5) ?? [];
        if (!recentSessions || recentSessions.length === 0) {
          return { content: [{ type: 'text', text: i18n.t('tools-session:noActiveSession') }] };
        }

        const results: string[] = [];
        const summarizeInterval = 20;

        for (const session of recentSessions) {
          const totalMessages = options.messageRepository.countBySessionId(session.id);
          const existingEpisodes = options.episodeRepository.findBySessionId(session.id).length;

          // Only summarize if there are enough new messages since last summary
          const expectedSummaries = Math.floor(totalMessages / summarizeInterval);

          if (totalMessages < 5) {
            results.push(i18n.t('tools-session:tooFewMessages', { id: session.id.slice(0, 12), count: totalMessages }));
            continue;
          }

          if (expectedSummaries <= existingEpisodes) {
            results.push(
              i18n.t('tools-session:thresholdNotReached', {
                id: session.id.slice(0, 12),
                summaryCount: existingEpisodes,
                messageCount: totalMessages,
              }),
            );
            continue;
          }

          // Trigger summarization
          await options.memorySummarizer.summarizeSession(session.id, { maxMessages: 50 });
          results.push(
            i18n.t('tools-session:summaryCreated', {
              id: session.id.slice(0, 12),
              index: expectedSummaries,
              messageCount: totalMessages,
              reason: args.reason ?? '',
            }),
          );
        }

        if (results.length === 0) {
          return { content: [{ type: 'text', text: i18n.t('tools-session:noSessionsNeeded') }] };
        }

        return { content: [{ type: 'text', text: results.join('\n') }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: i18n.t('tools-session:summaryFailed', { error: error instanceof Error ? error.message : String(error) }) }],
        };
      }
    },
  } as AgentTool<any>;
}
