/**
 * Wire iLink poller message events into the OhMyAgent pipeline.
 *
 * Handles:
 * - Text messages → AgentService.execute() with WechatReplyDispatcher
 * - Slash commands → local handler (unrecognized commands fall through to agent)
 * - Access control (allowedUsers)
 * - Context token tracking (required for replying within 24h window)
 * - Inbound media download (images → Vision Bridge, voice → text note)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import type { AgentService } from '../../src/agent/agent-service.js';
import type { CommandDeps } from '../../src/commands/command-handler.js';
import { handleCommand } from '../../src/commands/command-handler.js';
import type { ImageContent } from '../../src/pi-mono/ai/types.js';
import type { ExtensionAPI } from '../../src/extensions/types.js';
import type { WechatConfig, ILMessage, ILMediaParam } from './wechat-types.js';
import { TypingStatus, MessageState, MessageItemType } from './wechat-types.js';
import type { WechatPoller } from './wechat-poller.js';
import { buildMessageContext } from './message-context.js';
import { WechatReplyDispatcher } from './wechat-dispatcher.js';
import type { WechatReplyDispatcherOptions } from './wechat-dispatcher.js';
import { sendChunkedText, sendMessage } from './wechat-sender.js';
import { sendTyping, getConfig } from './wechat-api.js';
import { downloadInboundMedia, ILINK_CDN_HOST } from './wechat-media.js';
import { createWechatMediaTool, sendWechatMediaBuffer } from './wechat-media-tool.js';
import { createWechatApprovalSender } from './wechat-approval-sender.js';
import { resolveWechatErrorNotice } from './wechat-error.js';
import { ChatQueue } from '../channel-feishu/chat-queue.js';

/** 24-hour TTL for context tokens. */
const CONTEXT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

interface TokenEntry {
  token: string;
  toUserId: string;
  expiresAt: number;
}

// Module-level token store shared with cron delivery
const tokenMap = new Map<string, TokenEntry>();

// Clean expired tokens periodically
const _cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of tokenMap) {
    if (entry.expiresAt <= now) {
      tokenMap.delete(key);
    }
  }
}, 60_000);
if (typeof _cleanupInterval === 'object' && 'unref' in _cleanupInterval) {
  _cleanupInterval.unref();
}

/**
 * Get a valid context token for a sender, or null if expired / unknown.
 * Used by cron delivery to send messages outside the normal reply flow.
 */
export function getTokenForCron(senderId: string): { token: string; toUserId: string } | null {
  const entry = tokenMap.get(senderId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    tokenMap.delete(senderId);
    return null;
  }
  return { token: entry.token, toUserId: entry.toUserId };
}

export function setupMessageHandlers(
  poller: WechatPoller,
  sender: { apiBase: string; botToken: string },
  config: WechatConfig,
  agentService: AgentService,
  commandDeps: CommandDeps | undefined,
  logger: Logger,
  api: ExtensionAPI,
  sttTranscriber?: (audioPath: string, language?: string) => Promise<string>,
  sttConfig?: { autoTranscribe?: boolean; enabled?: boolean; language?: string },
): void {
  const chatQueue = new ChatQueue();

  poller.start(async (msg: ILMessage) => {
    // Build ChannelContext
    const channelCtx = buildMessageContext(msg);
    if (!channelCtx) return;

    // Check access control
    if (!isAllowed(channelCtx, config)) {
      logger.debug(
        { senderId: channelCtx.message.senderId },
        'WeChat user not in allowedUsers, skipping',
      );
      return;
    }

    // Store context token for future replies
    const senderId = channelCtx.message.senderId;
    if (msg.context_token) {
      tokenMap.set(senderId, {
        token: msg.context_token,
        toUserId: senderId,
        expiresAt: Date.now() + CONTEXT_TOKEN_TTL_MS,
      });
    }

    const text = channelCtx.message.text;
    const sessionKey = `wechat:${senderId}`;
    const messageId = channelCtx.message.id;

    // ── Slash commands (local handler, unrecognized fall through) ──
    if (text.startsWith('/') && commandDeps) {
      const tokenEntry = tokenMap.get(senderId);
      if (!tokenEntry) {
        logger.warn({ senderId }, 'No context token for command reply');
        return;
      }

      const cmdResult = await handleSlashCommand(
        text,
        sessionKey,
        commandDeps,
        messageId,
        senderId,
      );

      if (cmdResult.handled) {
        if (cmdResult.reply) {
          await sendChunkedText(
            sender.apiBase,
            sender.botToken,
            tokenEntry.toUserId,
            tokenEntry.token,
            cmdResult.reply,
            config.textLimit,
            logger,
          ).catch((err: unknown) => {
            logger.error({ err }, 'Failed to send command reply');
          });
        }

        // /agent <id> <message> — forward remaining text + media to agent
        if (cmdResult.forwardText) {
          logger.info(
            { sessionKey, forwardText: cmdResult.forwardText },
            'Forwarding to agent after command',
          );
          const { finalText: fwdText, images: fwdImages } =
            await processMessageMedia(msg, config, logger, sttTranscriber, sttConfig);
          const fwdAgentText = fwdText
            ? `${cmdResult.forwardText}\n${fwdText}`
            : cmdResult.forwardText;
          chatQueue.enqueue(sessionKey, () =>
            executeAgent(
              fwdAgentText,
              sessionKey,
              senderId,
              tokenEntry,
              sender,
              config,
              agentService,
              logger,
              fwdImages,
              api,
            ).catch(err => logger.error({ err, sessionKey }, 'WeChat queued agent failed')),
          );
        }
        return; // Command was handled
      }
      // Unrecognized command falls through to agent below
    }

    // ── Inbound media download ──
    const { finalText, images } = await processMessageMedia(msg, config, logger, sttTranscriber, sttConfig);
    const agentText = finalText || text;

    // ── Normal message → steer if running, otherwise execute ──
    if (agentService.isRunning(sessionKey)) {
      agentService.steer(sessionKey, agentText);
      return;
    }

    // ── Agent execution ──
    const tokenEntry = tokenMap.get(senderId);
    if (!tokenEntry) {
      logger.warn(
        { senderId },
        'No context token available for reply — message skipped',
      );
      return;
    }

    chatQueue.enqueue(sessionKey, () =>
      executeAgent(
        agentText,
        sessionKey,
        senderId,
        tokenEntry,
        sender,
        config,
        agentService,
        logger,
        images,
        api,
      ).catch(err => logger.error({ err, sessionKey }, 'WeChat queued agent failed')),
    );
  }).catch((err: Error) => {
    logger.error({ err }, 'WeChat poller crashed');
  });
}

// ---------------------------------------------------------------------------
// Agent execution
// ---------------------------------------------------------------------------

async function executeAgent(
  input: string,
  sessionKey: string,
  senderId: string,
  tokenEntry: TokenEntry,
  sender: { apiBase: string; botToken: string },
  config: WechatConfig,
  agentService: AgentService,
  logger: Logger,
  images: ImageContent[] | undefined,
  api: ExtensionAPI,
): Promise<void> {
  let typingTicket: string | undefined;
  const live = api.getConfig();

  const options: WechatReplyDispatcherOptions = {
    showToolCalls: live.showToolCalls,
    footerConfig: live.footer,
    sendText: async (text: string) => {
      logger.info({ textLen: text.length }, 'WeChat dispatching final text');
      await sendChunkedText(
        sender.apiBase,
        sender.botToken,
        tokenEntry.toUserId,
        tokenEntry.token,
        text,
        config.textLimit,
        logger,
      );
    },

    startTyping: async () => {
      if (!typingTicket) {
        try {
          const cfg = await getConfig(sender.apiBase, sender.botToken, {
            ilink_user_id: senderId,
            context_token: tokenEntry.token,
          });
          typingTicket = cfg.typing_ticket;
        } catch { /* ticket fetch is best-effort */ }
      }
      if (!typingTicket) return;
      await sendTyping(sender.apiBase, sender.botToken, {
        ilink_user_id: senderId,
        typing_ticket: typingTicket,
        status: TypingStatus.TYPING,
      }).catch(() => {});
    },

    stopTyping: async () => {
      if (!typingTicket) return;
      await sendTyping(sender.apiBase, sender.botToken, {
        ilink_user_id: senderId,
        typing_ticket: typingTicket,
        status: TypingStatus.CANCEL,
      }).catch(() => {});
    },
  };

  const dispatcher = new WechatReplyDispatcher(options);

  try {
    const mediaTool = createWechatMediaTool({
      apiBase: sender.apiBase,
      botToken: sender.botToken,
      toUserId: tokenEntry.toUserId,
      contextToken: tokenEntry.token,
      aesKey: config.aesKey,
      logger,
      allowedRoots: live.tools.fileRead.allowedRoots.length > 0
        ? live.tools.fileRead.allowedRoots : undefined,
      deniedPatterns: live.tools.fileRead.deniedPatterns.length > 0
        ? live.tools.fileRead.deniedPatterns : undefined,
    });
    const mediaOptions = {
      apiBase: sender.apiBase,
      botToken: sender.botToken,
      toUserId: tokenEntry.toUserId,
      contextToken: tokenEntry.token,
      aesKey: config.aesKey,
      logger,
      allowedRoots: live.tools.fileRead.allowedRoots.length > 0
        ? live.tools.fileRead.allowedRoots : undefined,
      deniedPatterns: live.tools.fileRead.deniedPatterns.length > 0
        ? live.tools.fileRead.deniedPatterns : undefined,
    };

    const wechatApprovalSender = createWechatApprovalSender({
      apiBase: sender.apiBase,
      botToken: sender.botToken,
      toUserId: tokenEntry.toUserId,
      contextToken: tokenEntry.token,
      textLimit: config.textLimit,
      logger,
    });

    const execOptions: Record<string, unknown> = {
      sessionId: sessionKey,
      chatId: senderId,
      messageId: String(Date.now()),
      replyDispatcherOverride: dispatcher,
      extraTools: [mediaTool],
      channelApprovalSender: wechatApprovalSender,
      computerUseImageSender: async (image: { data: string; mimeType: string }) => {
        const ext = image.mimeType === 'image/jpeg' ? 'jpg' : 'png';
        const fileName = `computer-use-screenshot-${Date.now()}.${ext}`;
        await sendWechatMediaBuffer(
          mediaOptions,
          Buffer.from(image.data, 'base64'),
          fileName,
          image.mimeType,
        );
        return `Sent to WeChat as ${fileName}`;
      },
      replyDispatcherFactory: () => {
        let freshTypingTicket: string | undefined;
        return new WechatReplyDispatcher({
          showToolCalls: live.showToolCalls,
          footerConfig: live.footer,
          sendText: async (text: string) => {
            await sendChunkedText(
              sender.apiBase, sender.botToken,
              tokenEntry.toUserId, tokenEntry.token,
              text, config.textLimit, logger,
            );
          },
          startTyping: async () => {
            if (!freshTypingTicket) {
              try {
                const cfg = await getConfig(sender.apiBase, sender.botToken, {
                  ilink_user_id: senderId,
                  context_token: tokenEntry.token,
                });
                freshTypingTicket = cfg.typing_ticket;
              } catch { /* best-effort */ }
            }
            if (!freshTypingTicket) return;
            await sendTyping(sender.apiBase, sender.botToken, {
              ilink_user_id: senderId,
              typing_ticket: freshTypingTicket,
              status: TypingStatus.TYPING,
            }).catch(() => {});
          },
          stopTyping: async () => {
            if (!freshTypingTicket) return;
            await sendTyping(sender.apiBase, sender.botToken, {
              ilink_user_id: senderId,
              typing_ticket: freshTypingTicket,
              status: TypingStatus.CANCEL,
            }).catch(() => {});
          },
        });
      },
      channel: 'wechat',
    };
    if (images && images.length > 0) {
      execOptions.images = images;
    }
    await agentService.execute(input, execOptions as any);
  } catch (err: unknown) {
    logger.error({ err }, 'WeChat agent execution failed');
    const error = err instanceof Error ? err : new Error(String(err));
    try {
      await sendChunkedText(
        sender.apiBase,
        sender.botToken,
        tokenEntry.toUserId,
        tokenEntry.token,
        resolveWechatErrorNotice(error),
        config.textLimit,
        logger,
      );
    } catch {
      // Ignore error sending error message
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAllowed(
  ctx: ReturnType<typeof buildMessageContext>,
  config: WechatConfig,
): boolean {
  if (!ctx) return false;
  if (config.allowedUsers.length === 0) return true;
  return config.allowedUsers.includes(ctx.message.senderId);
}

/**
 * Get a cached context token for a sender, or null if expired / unknown.
 */
export function getContextToken(
  tokenMap: Map<string, TokenEntry>,
  senderId: string,
): TokenEntry | null {
  const entry = tokenMap.get(senderId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    tokenMap.delete(senderId);
    return null;
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Slash command wrapper
// ---------------------------------------------------------------------------

/**
 * Local slash command handler that wraps the shared handleCommand.
 *
 * Returns `handled: false` for unrecognized commands so they can fall
 * through to the agent pipeline.
 */
async function handleSlashCommand(
  text: string,
  sessionKey: string,
  deps: CommandDeps,
  messageId: string,
  chatId?: string,
): Promise<{ handled: boolean; reply?: string; forwardText?: string }> {
  const result = await handleCommand(text, sessionKey, deps, messageId, chatId);
  if (!result) return { handled: false };
  return { handled: true, reply: result.reply, forwardText: result.forwardText };
}

// ---------------------------------------------------------------------------
// Inbound media processing
// ---------------------------------------------------------------------------

/**
 * Download inbound media items (images, voice) from the CDN and prepare
 * them for the agent pipeline.
 *
 * - Images are downloaded, decrypted, converted to ImageContent (Vision
 *   Bridge compatible), and returned in the `images` array.
 * - Voice messages are downloaded and a text note with the local file path
 *   is appended via `finalText`.
 *
 * @returns  Modified text suffix (if any) and an array of ImageContent.
 */
async function processMessageMedia(
  msg: ILMessage,
  config: WechatConfig,
  logger: Logger,
  sttTranscriber?: (audioPath: string, language?: string) => Promise<string>,
  sttConfig?: { autoTranscribe?: boolean; enabled?: boolean; language?: string },
): Promise<{ finalText?: string; images?: ImageContent[] }> {
  // v4 Phase 4: Media intake hook (skeleton)
  // if (MsgType === 'image') {
  //   const mediaUrl = `https://api.weixin.qq.com/cgi-bin/media/get?access_token=...&media_id=...`;
  //   // → resolver.resolveFromChannel() → store.ingest() → security.validate()
  //   // → add ImageContent to images[]
  // }
  // if (MsgType === 'voice') {
  //   // → resolver.resolveFromChannel() → store.ingest() → transcribe with AudioParser
  // }

  const mediaDir = path.join(config.cursorDir, 'media');
  const images: ImageContent[] = [];
  let voicePath: string | undefined;
  let voiceText: string | undefined;

  for (const item of msg.item_list) {
    let mediaParam: ILMediaParam | undefined;
    let itemType: string | undefined;

    switch (item.type) {
      case MessageItemType.IMAGE:
        mediaParam = item.image_item?.media;
        itemType = 'image';
        break;
      case MessageItemType.VOICE:
        // WeChat has built-in ASR: use it directly, skip download
        if (item.voice_item?.text?.trim()) {
          voiceText = item.voice_item.text.trim();
          continue;
        }
        mediaParam = item.voice_item?.media;
        itemType = 'voice';
        break;
      case MessageItemType.FILE:
        mediaParam = item.file_item?.media;
        itemType = 'file';
        break;
      case MessageItemType.VIDEO:
        mediaParam = item.video_item?.media;
        itemType = 'video';
        break;
    }

    if (!mediaParam?.encrypt_query_param || !mediaParam?.aes_key) continue;

    try {
      const ext = itemType === 'image' ? '.jpg' : itemType === 'voice' ? '.ogg' : '.bin';
      const savePath = path.join(
        mediaDir,
        `${msg.client_id || Date.now()}-${item.type}${ext}`,
      );

      await downloadInboundMedia(
        item,
        ILINK_CDN_HOST,
        mediaParam.aes_key,
        savePath,
        logger,
      );

      if (itemType === 'image') {
        const rawBuffer = await fs.readFile(savePath);
        images.push(bufferToImageContent(rawBuffer));
      } else if (itemType === 'voice') {
        voicePath = savePath;
      }
    } catch (err: unknown) {
      logger.error({ err, itemType }, 'Failed to download WeChat media');
    }
  }

  const result: { finalText?: string; images?: ImageContent[] } = {};
  // v5 P2: Voice handling — prefer WeChat built-in ASR, fall back to STT
  if (voiceText) {
    result.finalText = voiceText;
  } else if (voicePath && sttTranscriber && sttConfig?.enabled && sttConfig.autoTranscribe !== false) {
    try {
      const transcribed = await sttTranscriber(voicePath, sttConfig.language ?? 'auto');
      if (transcribed.trim()) {
        result.finalText = transcribed.trim();
      } else {
        result.finalText = `[已下载语音: ${voicePath}]`;
      }
    } catch (err) {
      logger.warn({ err }, 'WeChat voice transcription failed');
      result.finalText = `[已下载语音: ${voicePath}]`;
    }
  } else if (voicePath) {
    result.finalText = `[已下载语音: ${voicePath}]`;
  }
  if (images.length > 0) {
    result.images = images;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Image conversion utility
// ---------------------------------------------------------------------------

/**
 * Convert a raw image buffer to ImageContent (base64 + MIME detection)
 * for the Vision Bridge / agent multimodal pipeline.
 */
function bufferToImageContent(buffer: Buffer): ImageContent {
  const mimeType = detectImageMime(buffer);
  return { type: 'image', data: buffer.toString('base64'), mimeType };
}

/**
 * Detect image MIME type from magic bytes.
 */
function detectImageMime(buffer: Buffer): string {
  if (buffer.length < 4) return 'application/octet-stream';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif';
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return 'image/webp';
  return 'application/octet-stream';
}
