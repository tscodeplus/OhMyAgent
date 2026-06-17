/**
 * Message Persister
 *
 * Extracted from agent-service.ts. Persists agent state messages to the
 * database with support for tool-call block grouping, image/file extraction,
 * and metadata enrichment.
 */

import type { Agent } from '../pi-mono/agent/agent.js';
import type { MessageRepository } from '../memory/repositories/message-repository.js';
import type { Logger } from 'pino';
import type { FooterConfig } from '../app/types.js';
import { generateId } from '../shared/ids.js';
import { extractText, extractUserText } from '../shared/text-extract.js';

// ── Types ──

interface StreamMessageMeta {
  provider?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  model?: string;
}

export interface PersistMessagesOptions {
  agent: Agent;
  sessionKey: string;
  /** Persisted message counter (mutated in-place). */
  runtime: {
    persistedMessageCount: number;
    turnElapsed?: number;
    footerConfig?: FooterConfig;
    agentName?: string;
    /** Skill name activated for this turn (consumed on first assistant message). */
    skillActivatedName?: string;
    /** Respect showToolCalls setting — skip tool call metadata when false. */
    showToolCalls?: boolean;
  };
  messageRepository: MessageRepository;
  logger: Logger;
  /** Ensure the session row exists before persisting messages. */
  ensureSession: (sessionKey: string) => void;
}

// ── Persist ──

export async function persistMessages(opts: PersistMessagesOptions): Promise<void> {
  const { agent, sessionKey, runtime, messageRepository, logger, ensureSession } = opts;

  try {
    ensureSession(sessionKey);

    const agentState = agent.state as {
      messages?: Array<{
        role: string;
        content: string | Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: Record<string, unknown> }>;
        usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
        model?: string;
        timestamp?: number;
      }>;
    };
    const messages = agentState.messages ?? [];
    const startIndex = runtime.persistedMessageCount > messages.length
      ? 0
      : runtime.persistedMessageCount;
    const batchMessages = messages.slice(startIndex);
    const newMessages = batchMessages.filter(
      (msg) => msg.role === 'user' || msg.role === 'assistant',
    );

    // Pre-scan: extract images/files from toolResult messages in this batch
    const batchImages: Array<{ url: string; alt?: string }> = [];
    const batchFiles: Array<{ name: string; path: string }> = [];
    const seenUrls = new Set<string>();
    for (const m of batchMessages) {
      if (m.role !== 'toolResult' || !Array.isArray(m.content)) continue;
      const text = m.content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text || '')
        .join('\n');
      const imgRegex = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
      let imgMatch: RegExpExecArray | null;
      while ((imgMatch = imgRegex.exec(text)) !== null) {
        const url = imgMatch[2];
        if (!seenUrls.has(url)) {
          seenUrls.add(url);
          batchImages.push({ alt: imgMatch[1] || undefined, url });
        }
      }
      const linkRegex = /\[([^\]]+)\]\((\/[^)]+)\)/g;
      let lm: RegExpExecArray | null;
      while ((lm = linkRegex.exec(text)) !== null) {
        const linkUrl = lm[2];
        if (linkUrl.startsWith('/api/files/serve') || linkUrl.startsWith('/api/files/download')) {
          if (!seenUrls.has(linkUrl)) {
            seenUrls.add(linkUrl);
            batchFiles.push({ name: lm[1], path: linkUrl });
          }
        }
      }
    }

    // Group consecutive assistant messages to preserve block-level ordering
    interface PendingAssistant {
      blocks: Array<{ type: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> }>;
      usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
      model?: string;
      provider?: string;
    }

    let pendingAssistant: PendingAssistant | null = null;

    const flushPendingAssistant = (isFinal: boolean) => {
      const pending = pendingAssistant!;
      if (!pending || pending.blocks.length === 0) return;

      // 1. Join text blocks → flat content string
      const textParts: string[] = [];
      for (const block of pending.blocks) {
        if (block.type === 'text' && block.text) {
          textParts.push(block.text);
        }
      }
      let content = textParts.join('\n');

      // Prepend skill activation notification to content so it appears in
      // history even when rendered without segment support (plain text fallback).
      const skillPrefix = runtime.skillActivatedName
        ? `⚡️ 技能激活：**${runtime.skillActivatedName}**\n\n`
        : '';
      if (skillPrefix) {
        content = skillPrefix + content;
      }

      // Strip image markdown already in batchImages
      if (batchImages.length > 0) {
        for (const img of batchImages) {
          const escaped = img.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          content = content.replace(new RegExp(`!\\[[^\\]]*\\]\\(${escaped}\\)`, 'g'), '');
        }
        content = content.trim();
      }

      // 2. Extract tool calls from blocks (deduplicated by id).
      // Skip when showToolCalls is off — tool metadata must not leak into
      // persisted messages, otherwise they'd appear on page refresh.
      const persistTools = runtime.showToolCalls !== false;
      const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
      const toolCallIds = new Set<string>();
      if (persistTools) {
        for (const block of pending.blocks) {
          if (block.type === 'toolCall' && block.id && block.name && !toolCallIds.has(block.id)) {
            toolCallIds.add(block.id);
            toolCalls.push({
              id: block.id,
              name: block.name,
              arguments: (block.arguments || {}) as Record<string, unknown>,
            });
          }
        }
      }

      if (!content.trim() && toolCalls.length === 0) return;

      // 3. Build segments from block order when tool calls or skill are present
      let segments: Array<{ type: 'text'; content: string } | { type: 'tool_call'; id: string } | { type: 'skill'; name: string }> | undefined;
      const hasSkill = !!runtime.skillActivatedName;
      const hasToolSegments = persistTools && toolCalls.length > 0;
      if (hasToolSegments || hasSkill) {
        segments = [];
        // Skill activation segment goes first (before any text/tool blocks)
        if (hasSkill) {
          segments.push({ type: 'skill', name: runtime.skillActivatedName! });
        }
        for (const block of pending.blocks) {
          if (block.type === 'text' && block.text) {
            segments.push({ type: 'text', content: block.text });
          } else if (persistTools && block.type === 'toolCall' && block.id) {
            segments.push({ type: 'tool_call', id: block.id });
          }
        }
      }

      // 4. Build metadata
      const meta: Record<string, unknown> = {};
      // Skill activation notification — attached to first assistant message, then cleared
      if (runtime.skillActivatedName) {
        meta.skill_activated = runtime.skillActivatedName;
        runtime.skillActivatedName = undefined;
      }
      if (segments) meta.segments = segments;
      if (persistTools && toolCalls.length > 0) meta.tool_calls = toolCalls;
      if (isFinal) {
        if (batchImages.length > 0) meta.images = batchImages;
        if (batchFiles.length > 0) meta.files = batchFiles;
      }
      if (pending.usage) {
        meta.usage = {
          input: pending.usage.input ?? 0,
          output: pending.usage.output ?? 0,
          cacheRead: pending.usage.cacheRead ?? 0,
          cacheWrite: pending.usage.cacheWrite ?? 0,
        };
      }
      if (pending.model) {
        meta.model = pending.provider
          ? (pending.model.startsWith(`${pending.provider}/`) ? pending.model : `${pending.provider}/${pending.model}`)
          : pending.model;
      }
      const agentName = agent.ohmyagent_agentName || runtime.agentName;
      if (agentName) meta.agentName = agentName;
      if (runtime.turnElapsed) meta.elapsed = runtime.turnElapsed;
      if (runtime.footerConfig) meta.footerConfig = runtime.footerConfig;

      const metadata = Object.keys(meta).length > 0 ? JSON.stringify(meta) : null;

      messageRepository.create({
        id: generateId(),
        session_id: sessionKey,
        role: 'assistant',
        content,
        metadata,
      });
    };

    for (let mi = 0; mi < newMessages.length; mi++) {
      const msg = newMessages[mi];

      if (msg.role === 'user') {
        if (pendingAssistant !== null) {
          flushPendingAssistant(false);
          pendingAssistant = null;
        }
        const content = extractUserText(msg.content);
        if (content.trim()) {
          messageRepository.create({
            id: generateId(),
            session_id: sessionKey,
            role: 'user',
            content,
            metadata: null,
            created_at: msg.timestamp,
          });
        }
        continue;
      }

      if (msg.role === 'assistant') {
        const hasToolCalls = Array.isArray(msg.content) &&
          msg.content.some((block: any) => block.type === 'toolCall');
        const pendingHasToolCalls = pendingAssistant !== null &&
          pendingAssistant.blocks.some(b => b.type === 'toolCall');

        // Persist immediately when no tool calls are involved
        if (!hasToolCalls && !pendingHasToolCalls) {
          if (pendingAssistant !== null) {
            flushPendingAssistant(false);
            pendingAssistant = null;
          }

          let content = extractText(msg.content);
          if (batchImages.length > 0) {
            for (const img of batchImages) {
              const escaped = img.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              content = content.replace(new RegExp(`!\\[[^\\]]*\\]\\(${escaped}\\)`, 'g'), '');
            }
            content = content.trim();
          }
          // Prepend skill activation text for plain-text fallback rendering
          const noTcSkillPrefix = runtime.skillActivatedName
            ? `⚡️ 技能激活：**${runtime.skillActivatedName}**\n\n`
            : '';
          if (noTcSkillPrefix && content.trim()) {
            content = noTcSkillPrefix + content;
          }
          if (content.trim() || noTcSkillPrefix) {
            const meta: Record<string, unknown> = {};
            // Skill activation notification — attached to first assistant message, then cleared
            if (runtime.skillActivatedName) {
              meta.skill_activated = runtime.skillActivatedName;
              // Add a skill segment so the frontend can render it as a card
              meta.segments = [{ type: 'skill', name: runtime.skillActivatedName }];
              runtime.skillActivatedName = undefined;
            }
            if (msg.usage) {
              meta.usage = {
                input: msg.usage.input ?? 0,
                output: msg.usage.output ?? 0,
                cacheRead: msg.usage.cacheRead ?? 0,
                cacheWrite: msg.usage.cacheWrite ?? 0,
              };
            }
            if (msg.model) {
              const prov = (msg as unknown as StreamMessageMeta).provider;
              meta.model = prov
                ? (msg.model.startsWith(`${prov}/`) ? msg.model : `${prov}/${msg.model}`)
                : msg.model;
            }
            const agentName = agent.ohmyagent_agentName || runtime.agentName;
            if (agentName) meta.agentName = agentName;
            if (runtime.turnElapsed) meta.elapsed = runtime.turnElapsed;
            if (runtime.footerConfig) meta.footerConfig = runtime.footerConfig;
            const lastAssistantIndex = newMessages.reduce(
              (last, m, i) => m.role === 'assistant' ? i : last, -1,
            );
            if (mi === lastAssistantIndex) {
              if (batchImages.length > 0) meta.images = batchImages;
              if (batchFiles.length > 0) meta.files = batchFiles;
            }
            const metadata = Object.keys(meta).length > 0 ? JSON.stringify(meta) : null;

            messageRepository.create({
              id: generateId(),
              session_id: sessionKey,
              role: 'assistant',
              content,
              metadata,
            });
          }
          continue;
        }

        // Tool calls involved — accumulate into pending group
        if (pendingAssistant === null) {
          pendingAssistant = { blocks: [] };
        }

        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type !== 'thinking') {
              pendingAssistant.blocks.push(block);
            }
          }
        } else if (typeof msg.content === 'string' && msg.content.trim()) {
          pendingAssistant.blocks.push({ type: 'text', text: msg.content });
        }

        if (msg.usage) pendingAssistant.usage = msg.usage;
        if (msg.model) pendingAssistant.model = msg.model;
        if ((msg as unknown as StreamMessageMeta).provider) pendingAssistant.provider = (msg as unknown as StreamMessageMeta).provider;
      }
    }

    // Flush final pending assistant group
    if (pendingAssistant !== null) {
      flushPendingAssistant(true);
      pendingAssistant = null;
    }

    runtime.persistedMessageCount = messages.length;

    logger.info({ sessionKey, messageCount: newMessages.length }, 'Messages persisted');
  } catch (err) {
    logger.warn({ err, sessionKey }, 'Failed to persist messages');
  }
}
