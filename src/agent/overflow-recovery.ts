/**
 * Context Overflow Recovery
 *
 * Extracted from agent-service.ts. Detects context overflow errors on
 * assistant messages, compresses the conversation history, and retries
 * the turn with compacted context.
 */

import type { Agent } from '../pi-mono/agent/agent.js';
import { isContextOverflow } from '@earendil-works/pi-ai';
import { compressContext } from './compress.js';
import type { Logger } from 'pino';

export interface OverflowRecoveryOptions {
  agent: Agent;
  sessionId: string;
  compressCfg: {
    contextWindow: number;
    mainModelRef: string;
    globalFallbackRefs: string[];
    compressModelRef?: string;
    compressFallbackRefs?: string[];
    apiKeys: Record<string, string>;
    baseUrls: Record<string, string>;
    baseUrl?: string;
  };
  logger: Logger;
  /** Called after successful retry to re-persist messages. */
  onRetryPersist: () => Promise<void>;
}

/**
 * Check for context overflow and recover via compression + retry.
 * Returns true if a recovery retry was attempted.
 */
export async function recoverFromOverflow(opts: OverflowRecoveryOptions): Promise<boolean> {
  const { agent, sessionId, compressCfg, logger, onRetryPersist } = opts;

  const messages = agent.state.messages;
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || lastMsg.role !== 'assistant') return false;

  const assistantMsg = lastMsg as import('@earendil-works/pi-ai').AssistantMessage;
  if (!isContextOverflow(assistantMsg, compressCfg.contextWindow)) return false;

  logger.info({ sessionId }, 'Context overflow detected, compacting and retrying');

  // Remove the overflow error message from state
  agent.state.messages = messages.slice(0, -1);

  // Compress context
  try {
    const result = await compressContext({
      messages: agent.state.messages,
      contextWindow: compressCfg.contextWindow,
      settings: { reserveTokens: 16384, keepRecentTokens: 20000 },
      sessionKey: sessionId,
      mainModelRef: compressCfg.mainModelRef,
      globalFallbackRefs: compressCfg.globalFallbackRefs,
      compressModelRef: compressCfg.compressModelRef,
      compressFallbackRefs: compressCfg.compressFallbackRefs,
      apiKeys: compressCfg.apiKeys,
      baseUrls: compressCfg.baseUrls,
      baseUrl: compressCfg.baseUrl,
      logger,
    });

    if (result.summaryMessage && result.compressedIndex > 0) {
      const recentMessages = agent.state.messages.slice(result.compressedIndex);
      agent.state.messages = [result.summaryMessage, ...recentMessages];
      logger.info({
        sessionId,
        compressedCount: result.compressedIndex,
        keptCount: recentMessages.length,
      }, 'Context compacted after overflow, retrying');
    }
  } catch (err) {
    logger.warn({ sessionId, err }, 'Overflow compaction failed, continuing without retry');
    return false;
  }

  // Retry the turn with compacted context
  try {
    await agent.continue();
    await onRetryPersist();
    return true;
  } catch (err) {
    logger.warn({ sessionId, err }, 'Overflow retry failed');
    return false;
  }
}
