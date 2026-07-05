// ---------------------------------------------------------------------------
// Wire QQ Bot API v2 gateway events into the OhMyAgent pipeline.
//
// Handles:
// - C2C_MESSAGE_CREATE and GROUP_AT_MESSAGE_CREATE events only
// - Slash commands → shared command handler (src/commands/command-handler.ts)
// - Normal messages → AgentService.execute() with QQReplyDispatcher
// - Access control (allowedUsers, allowedGroups)
// - Self-message filtering
// ---------------------------------------------------------------------------

import type { Logger } from 'pino';
import type { QQConfig, QQWsPayload, QQMessageEvent } from './qq-types.js';
import type { AgentService } from '../../src/agent/agent-service.js';
import type { CommandDeps } from '../../src/commands/command-handler.js';
import type { FooterConfig } from '../../src/app/types.js';
import type { ExtensionAPI } from '../../src/extensions/types.js';
import { handleCommand } from '../../src/commands/command-handler.js';
import { buildMessageContext } from './message-context.js';
import { QQReplyDispatcher } from './qq-dispatcher.js';
import { sendChunkedText } from './send-message.js';
import { createQqMediaTool, sendQQMediaBuffer } from './qq-media-tool.js';
import { isGroupMessage, isAllowedGroup } from './group-handler.js';
import type { QQGateway, ReplyTracker } from './qq-gateway.js';
import { createReplyTracker } from './qq-gateway.js';
import { isMessageEvent, isInteractionEvent, type QQInteractionEvent } from './qq-types.js';
import { createQQApprovalSender } from './send-message.js';
import { handleApprovalInteraction } from './qq-approval-handler.js';
import { parseQuestionCallback } from './qq-keyboard.js';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatQueue } from '../channel-feishu/chat-queue.js';

export function setupMessageHandlers(
  gateway: QQGateway,
  config: QQConfig,
  agentService: AgentService,
  commandDeps: CommandDeps | undefined,
  logger: Logger,
  api: ExtensionAPI,
  sttTranscriber?: (audioPath: string, language?: string) => Promise<string>,
  sttConfig?: { autoTranscribe?: boolean; enabled?: boolean; language?: string },
): void {
  // Create a per-user reply rate limiter (5 replies / 60 s)
  const replyTracker = createReplyTracker();

  // Create a per-session task queue to serialize agent executions
  const chatQueue = new ChatQueue();

  // Wire approval AND question button callbacks via INTERACTION_CREATE
  gateway.setApprovalHandler(async (event: QQInteractionEvent) => {
    const target: { openid?: string; groupOpenid?: string } = {};
    if (event.group_openid) {
      target.groupOpenid = event.group_openid;
    } else if (event.user_openid) {
      target.openid = event.user_openid;
    }

    const buttonData = event.data?.resolved?.button_data;
    if (buttonData) {
      // Check for question answer first
      const questionParsed = parseQuestionCallback(buttonData);
      if (questionParsed) {
        await handleQuestionInteraction(event, questionParsed, target, agentService, gateway, logger);
        return;
      }
      // Fall through to approval handler
    }

    await handleApprovalInteraction(event, {
      agentService,
      gateway,
      target,
      logger,
    });
  });

  gateway.onEvent(async (payload: QQWsPayload) => {
    try {
      // ── Stage 1: Accept only C2C and GROUP_AT message events ──
      if (!isMessageEvent(payload)) return;
      const event = payload as QQMessageEvent;

      // ── Stage 2: Build channel context ──
      // selfId is the bot's QQ openid — for QQ Bot API v2, we use the
      // appId as a surrogate since the bot's openid may not be known
      // until the first message arrives.
      const selfId = config.appId;
      const channelCtx = buildMessageContext(event, selfId);
      if (!channelCtx) return;

      // ── Stage 3: Access control (allowedUsers) ──
      if (
        config.allowedUsers.length > 0 &&
        !config.allowedUsers.includes(channelCtx.message.senderId)
      ) {
        logger.debug({ userId: channelCtx.message.senderId }, 'QQ user not in allowedUsers, skipping');
        return;
      }

      // ── Stage 4: Group message gating ──
      if (isGroupMessage(payload)) {
        if (!isAllowedGroup(event, config.allowedGroups)) {
          logger.debug({ groupOpenid: event.d.group_openid }, 'QQ group not in allowedGroups, skipping');
          return;
        }
        // QQ Bot API v2 only delivers GROUP_AT_MESSAGE_CREATE when the bot
        // is @-mentioned, so no explicit mention check is required.
      }

      // ── Stage 5: Build session context ──
      const text = channelCtx.message.text;
      const sessionKey = isGroupMessage(payload)
        ? `qq:group:${event.d.group_openid ?? event.d.group_id}`
        : `qq:c2c:${event.d.author.user_openid}`;
      // Prefixed chatId so cron delivery knows whether to use user or group endpoint
      const chatId = isGroupMessage(payload)
        ? `g:${channelCtx.channelId}`
        : `u:${channelCtx.channelId}`;
      const messageId = event.d.id;
      const openid = event.d.author.user_openid;

      // v5 P2: Handle voice messages
      // QQ provides built-in ASR (asr_refer_text); prefer it over downloading.
      let agentText = text;
      const attachments = event.d.attachments;
      if (attachments?.length) {
        for (const att of attachments) {
          const ct = att.content_type.toLowerCase();
          if (ct === 'voice' || ct.startsWith('voice/') || ct.startsWith('audio/')) {
            // QQ already transcribes voice messages — use that text directly
            const qqAsrText = (att as any).asr_refer_text as string | undefined;
            if (qqAsrText?.trim()) {
              agentText = qqAsrText.trim();
              break;
            }
            // Fallback: download via WAV URL and transcribe ourselves
            const downloadUrl = (att as any).voice_wav_url as string ?? att.url;
            if (downloadUrl && sttTranscriber && sttConfig?.enabled && sttConfig.autoTranscribe !== false) {
              try {
                const resp = await fetch(downloadUrl);
                if (resp.ok) {
                  const audioBuf = Buffer.from(await resp.arrayBuffer());
                  const suffix = ct.includes('ogg') ? '.ogg' : '.mp3';
                  const tmpPath = join(tmpdir(), `qq-audio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${suffix}`);
                  await writeFile(tmpPath, audioBuf);
                  try {
                    const transcribed = await sttTranscriber(tmpPath, sttConfig.language ?? 'auto');
                    if (transcribed.trim()) agentText = transcribed.trim();
                  } finally {
                    try { await unlink(tmpPath); } catch { /* cleanup */ }
                  }
                }
              } catch (err) {
                logger.warn({ err }, 'QQ voice download/transcription failed');
              }
            }
            break;
          }
        }
      }
      if (!agentText) return;

      // Build reply target from the channel context's replyMeta
      const replyMeta = channelCtx.message.replyMeta as Record<string, unknown> | undefined;
      const target: { openid?: string; groupOpenid?: string } = {};
      if (replyMeta?.groupOpenid) {
        target.groupOpenid = replyMeta.groupOpenid as string;
      } else if (replyMeta?.openid) {
        target.openid = replyMeta.openid as string;
      } else {
        // Fallback — use sender's openid for C2C
        target.openid = event.d.author.user_openid;
      }

      // ── Stage 6: Command interception ──
      if (text.startsWith('/')) {
        const deps: CommandDeps = commandDeps ?? ({
          agentService,
          skillRegistry: undefined,
          cronService: undefined,
          feishuClient: undefined,
          agentManager: undefined,
          extensionManager: undefined,
        } as CommandDeps);

        const result = await handleCommand(text, sessionKey, deps, messageId, chatId);

        if (result) {
          if (result.reply) {
            await sendChunkedText(gateway, result.reply, target, config.textLimit);
          }

          if (result.forwardText) {
            const forwardText = result.forwardText;
            logger.info({ sessionKey, forwardText }, 'QQ forwarding to agent after command');
            const live = api.getConfig();
            chatQueue.enqueue(sessionKey, () =>
              executeAgent(forwardText, sessionKey, chatId, messageId, target, openid, gateway, config, agentService, logger, replyTracker, live.showToolCalls, live.showSkillCalls, live.footer, live.tools.fileRead.allowedRoots, live.tools.fileRead.deniedPatterns).catch(err => logger.error({ err, sessionKey }, 'QQ queued agent failed')),
            );
          }
          return;
        }
        // Unrecognized command — fall through to agent
      }

      // ── Stage 7: Check pending question, then steer if running, otherwise execute ──
      if (agentService.isRunning(sessionKey)) {
        const resolved = agentService.resolveFirstPendingQuestion(sessionKey, agentText);
        if (resolved) {
          await sendChunkedText(gateway, '✅ 已收到回答', target, config.textLimit).catch(() => {});
          return;
        }
        agentService.steer(sessionKey, agentText);
        return;
      }
      const liveConfig = api.getConfig();
      chatQueue.enqueue(sessionKey, () =>
        executeAgent(agentText, sessionKey, chatId, messageId, target, openid, gateway, config, agentService, logger, replyTracker, liveConfig.showToolCalls, liveConfig.showSkillCalls, liveConfig.footer, liveConfig.tools.fileRead.allowedRoots, liveConfig.tools.fileRead.deniedPatterns).catch(err => logger.error({ err, sessionKey }, 'QQ queued agent failed')),
      );
    } catch (err) {
      logger.error({ err, t: (payload as any)?.t }, 'QQ message handler error');
    }
  });

  logger.info({ appId: config.appId }, 'QQ message handlers registered');
}

// ── Question interaction handler ──

async function handleQuestionInteraction(
  event: import('./qq-types.js').QQInteractionEvent,
  parsed: { requestId: string; answer: string },
  target: { openid?: string; groupOpenid?: string },
  agentService: AgentService,
  gateway: QQGateway,
  logger: Logger,
): Promise<{ code: number; message: string }> {
  try {
    // Acknowledge the interaction so QQ disables the button group
    try {
      await gateway.sendRestApi('PUT', `/interactions/${event.id}`, { code: 0 });
    } catch (err) {
      logger.warn({ err, interactionId: event.id }, 'QQ question interaction acknowledge failed');
    }

    const resolved = agentService.resolveUserQuestion(parsed.requestId, parsed.answer);
    logger.info({ requestId: parsed.requestId, answer: parsed.answer, resolved }, 'QQ question answer resolved');

    if (resolved) {
      await sendChunkedText(gateway, `✅ 回答: ${parsed.answer}`, target, 2000).catch(() => {});
      return { code: 0, message: 'ok' };
    }

    await sendChunkedText(gateway, '该问题已被回答或已超时。', target, 2000).catch(() => {});
    return { code: 2, message: 'already resolved' };
  } catch (err) {
    logger.error({ err }, 'QQ question interaction error');
    return { code: -1, message: String(err) };
  }
}

// ── Agent execution ──

async function executeAgent(
  input: string,
  sessionKey: string,
  chatId: string,
  messageId: string,
  target: { openid?: string; groupOpenid?: string },
  openid: string,
  gateway: QQGateway,
  config: QQConfig,
  agentService: AgentService,
  logger: Logger,
  replyTracker: ReplyTracker,
  showToolCalls: boolean,
  showSkillCalls: boolean,
  footerConfig?: FooterConfig,
  allowedRoots?: string[],
  deniedPatterns?: string[],
): Promise<void> {
  // ── Rate-limit check: skip if user exceeds reply quota ──
  if (!replyTracker.checkMessageReplyLimit(openid)) {
    logger.warn({ openid, sessionKey }, 'QQ reply limit exceeded, sending throttling notice');
    try {
      await sendChunkedText(gateway, '消息发送过于频繁，请稍后再试。', target, config.textLimit);
    } catch {
      // Best-effort throttling notification
    }
    return;
  }

  const dispatcher = new QQReplyDispatcher(gateway, target, config, showToolCalls, showSkillCalls, footerConfig);
  dispatcher.setReplyTracker(replyTracker, openid);

  // v4 Phase 4: Media intake hook (skeleton)
  // if (msg.attachments) {
  //   for (const att of msg.attachments) {
  //     const fileUrl = `https://api.sgroup.qq.com/.../${att.file_uuid}`;
  //     // → resolver.resolveFromChannel() → store.ingest() → security.validate()
  //     // → if image: add to images[] for agent
  //     // → else: append description to input
  //   }
  // }

  const mediaTool = createQqMediaTool({
    gateway,
    openid: target.openid,
    groupOpenid: target.groupOpenid,
    allowedRoots: allowedRoots && allowedRoots.length > 0 ? allowedRoots : undefined,
    deniedPatterns: deniedPatterns && deniedPatterns.length > 0 ? deniedPatterns : undefined,
  });

  const approvalSender = createQQApprovalSender({
    gateway,
    target,
    triggerMessageId: messageId,
  });

  // ChatQueue serializes execution per session, so it's safe to await here.
  // Approval interaction events go through setApprovalHandler, not ChatQueue.
  await agentService.execute(input, {
    sessionId: sessionKey,
    chatId,
    messageId,
    replyDispatcherOverride: dispatcher,
    replyDispatcherFactory: () => {
      const d = new QQReplyDispatcher(gateway, target, config, showToolCalls, showSkillCalls, footerConfig);
      d.setReplyTracker(replyTracker, openid);
      return d;
    },
    extraTools: [mediaTool],
    channel: 'qq',
    computerUseImageSender: async (image) => {
      const ext = image.mimeType === 'image/jpeg' ? 'jpg' : 'png';
      const fileName = `computer-use-screenshot-${Date.now()}.${ext}`;
      await sendQQMediaBuffer(
        gateway,
        Buffer.from(image.data, 'base64'),
        fileName,
        1,
        target,
      );
      return `Sent to QQ as ${fileName}`;
    },
    channelApprovalSender: {
      sendApprovalMessage: (chatIdStr, requestId, command, risk, reason) =>
        approvalSender.sendApprovalMessage(chatIdStr, requestId, command, risk, reason),
      updateApprovalResult: (chatIdStr, messageIdStr, decision, command) =>
        approvalSender.updateApprovalResult(chatIdStr, messageIdStr, decision, command),
    },
  });
}
