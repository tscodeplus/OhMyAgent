/**
 * Wire grammY bot events into the OhMyAgent pipeline.
 *
 * Handles:
 * - Text messages → AgentService.execute() with TelegramReplyDispatcher
 * - Slash commands → shared command handler (src/commands/command-handler.ts)
 * - Callback queries (inline keyboard) → approval routing
 * - Access control (allowedUsers, allowedGroups)
 * - Group chat @mention gating
 */
import type { Bot } from 'grammy';
import type { Logger } from 'pino';
import type { TelegramConfig } from './telegram-types.js';
import type { AgentService } from '../../src/agent/agent-service.js';
import type { CommandDeps } from '../../src/commands/command-handler.js';
import type { FooterConfig } from '../../src/app/types.js';
import type { ExtensionAPI } from '../../src/extensions/types.js';
import { handleCommand } from '../../src/commands/command-handler.js';
import { buildMessageContext } from './message-context.js';
import { StreamControllerImpl } from './stream-controller.js';
import { TelegramReplyDispatcher } from './telegram-dispatcher.js';
import { createTelegramMediaTool, sendTelegramMediaBuffer } from './telegram-media-tool.js';
import { parseCallbackAction } from './inline-keyboard.js';
import { createTelegramApprovalSender } from './approval-sender.js';
import { markdownToHtml } from './markdown-to-html.js';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { i18n } from '../../src/i18n/index.js';
import { ChatQueue } from '../channel-feishu/chat-queue.js';

export function setupMessageHandlers(
  bot: Bot,
  config: TelegramConfig,
  agentService: AgentService,
  commandDeps: CommandDeps,
  logger: Logger,
  api: ExtensionAPI,
  sttTranscriber?: (audioPath: string, language?: string) => Promise<string>,
  sttConfig?: { autoTranscribe?: boolean; enabled?: boolean; language?: string },
): void {
  const chatQueue = new ChatQueue();

  // Log every non-message update to catch callback_query
  bot.use(async (ctx, next) => {
    const keys = Object.keys(ctx.update).filter(k => k !== 'update_id');
    if (keys.some(k => k !== 'message')) {
      logger.info({ updateKeys: keys }, 'Telegram non-message update');
    }
    await next();
  });

  bot.catch((err) => {
    logger.error({ err }, 'grammY bot error');
  });

  // Resolve bot username lazily — bot.botInfo throws if bot.init() hasn't been called.
  // In polling mode, init happens via bot.start(); ctx.me is available per-message.
  let botUsername = 'bot';

  // ── Text messages ──
  bot.on('message:text', async (ctx) => {
    // Resolve bot username from context (available after polling/webhook starts)
    if (botUsername === 'bot') {
      botUsername = (ctx as any).me?.username ?? 'bot';
    }
    const channelCtx = buildMessageContext(ctx, botUsername);
    if (!channelCtx) return;

    if (!isAllowed(channelCtx, config)) return;
    if (isGroup(channelCtx) && !isMentioningBot(ctx, botUsername) && !isReplyToBot(ctx as any, botUsername)) return;

    const text = channelCtx.message.text;
    const sessionKey = `telegram:${(ctx as any).chat.id}`;
    const chatId = String((ctx as any).chat.id);

    // ── /start — Telegram-specific welcome ──
    if (text === '/start' || text === '/start@' + botUsername) {
      await handleStart(ctx as any);
      return;
    }

    // ── All other slash commands → shared command handler ──
    if (text.startsWith('/')) {
      const result = await handleCommand(text, sessionKey, commandDeps, String((ctx as any).message?.message_id ?? ''), chatId);

      if (result) {
        // Command was recognized and handled
        if (result.reply) {
          const html = markdownToHtml(result.reply);
          try {
            await (ctx as any).reply(html, { parse_mode: 'HTML' });
          } catch {
            await (ctx as any).reply(html);
          }
        }

        // /agent <id> <message> — forward remaining text to agent
        if (result.forwardText) {
          const forwardText = result.forwardText;
          logger.info({ sessionKey, forwardText }, 'Forwarding to agent after command');
          const live = api.getConfig();
          chatQueue.enqueue(sessionKey, () =>
            executeAgent(forwardText, sessionKey, chatId, ctx, config, agentService, logger, bot, live.showToolCalls, live.footer, live.tools.fileRead.allowedRoots, live.tools.fileRead.deniedPatterns).catch(err => logger.error({ err }, 'Telegram queued agent failed')),
          );
        }
        return;
      }
      // Unrecognized command — let the agent handle it
    }

    // ── Normal message → steer if running, otherwise execute ──
    if (agentService.isRunning(sessionKey)) {
      agentService.steer(sessionKey, text);
      return;
    }
    const live = api.getConfig();
    chatQueue.enqueue(sessionKey, () =>
      executeAgent(text, sessionKey, chatId, ctx, config, agentService, logger, bot, live.showToolCalls, live.footer, live.tools.fileRead.allowedRoots, live.tools.fileRead.deniedPatterns).catch(err => logger.error({ err }, 'Telegram queued agent failed')),
    );
  });

  // ── Media messages ──
  bot.on(['message:photo', 'message:document', 'message:audio', 'message:voice', 'message:video', 'message:sticker'], async (ctx) => {
    if (botUsername === 'bot') botUsername = (ctx as any).me?.username ?? 'bot';
    const channelCtx = buildMessageContext(ctx, botUsername);
    if (!channelCtx) return;

    if (!isAllowed(channelCtx, config)) return;
    if (isGroup(channelCtx) && !isMentioningBot(ctx, botUsername) && !isReplyToBot(ctx as any, botUsername)) return;

    const chatIdNum = (ctx as any).chat?.id;
    if (!chatIdNum) return;

    const msg = ctx.message as Record<string, unknown> | undefined;
    const isAudio = msg?.voice !== undefined || msg?.audio !== undefined;

    // v5 P2: Auto-transcribe voice/audio messages
    let mediaText = channelCtx.message.text || '[Media]';
    if (isAudio && sttTranscriber && sttConfig?.enabled && sttConfig.autoTranscribe !== false) {
      const fileId = ((msg?.voice ?? msg?.audio) as Record<string, unknown>)?.file_id as string;
      if (fileId) {
        try {
          const file = await bot.api.getFile(fileId);
          const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
          // Prefer the Telegram-specific proxy used by grammY; fall back to global proxy envs.
          let fetchOpts: RequestInit & { dispatcher?: any } = {};
          const proxyUrl = config.proxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
          if (proxyUrl) {
            const { ProxyAgent } = await import('undici');
            fetchOpts.dispatcher = new ProxyAgent(proxyUrl);
          }
          const resp = await fetch(fileUrl, fetchOpts);
          if (resp.ok) {
            const audioBuf = Buffer.from(await resp.arrayBuffer());
            const tmpPath = join(tmpdir(), `tg-audio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ogg`);
            await writeFile(tmpPath, audioBuf);
            try {
              const transcribed = await sttTranscriber(
                tmpPath,
                sttConfig.language ?? 'auto',
              );
              if (transcribed.trim()) mediaText = transcribed.trim();
            } finally {
              try { await unlink(tmpPath); } catch { /* cleanup */ }
            }
          }
        } catch (err) {
          logger.warn({ err }, 'Telegram audio transcription failed');
        }
      }
    }

    const live = api.getConfig();
    const mediaSessionKey = `telegram:${chatIdNum}`;
    const mediaChatId = String(chatIdNum);
    chatQueue.enqueue(mediaSessionKey, () =>
      executeAgent(
        mediaText,
        mediaSessionKey,
        mediaChatId,
        ctx,
        config,
        agentService,
        logger,
        bot,
        live.showToolCalls,
        live.footer,
        live.tools.fileRead.allowedRoots,
        live.tools.fileRead.deniedPatterns,
      ).catch(err => logger.error({ err }, 'Telegram queued agent failed')),
    );
  });

  // ── Inline keyboard callbacks ──
  bot.on('callback_query:data', async (ctx) => {
    const cb = (ctx as any).callbackQuery ?? (ctx as any).update?.callback_query;
    const data = cb?.data;
    logger.info({ hasCb: !!cb, hasData: !!data, data }, 'Telegram callback_query received');

    if (!data) return;

    const action = parseCallbackAction(data);
    if (!action) {
      logger.warn({ data }, 'Telegram callback: failed to parse callback_data');
      return;
    }

    // Answer the callback query to dismiss the loading spinner on the client
    try {
      await bot.api.answerCallbackQuery(cb.id);
    } catch (e) {
      logger.warn({ err: e }, 'Telegram: answerCallbackQuery failed');
    }

    if (action.type === 'approve') {
      const resolved = agentService.resolveApproval(action.requestId, action.decision);
      logger.info({ requestId: action.requestId, decision: action.decision, resolved }, 'Telegram approval resolved');

      if (resolved) {
        const label = i18n.t(`telegram-approval:result.${action.decision}`);
        const emoji = action.decision.startsWith('approve') ? '✅' : '❌';
        try {
          const msg = cb.message;
          if (msg) {
            await bot.api.editMessageText(msg.chat.id, msg.message_id,
              `${emoji} ${label}`,
              { reply_markup: undefined },
            );
          }
        } catch (err) {
          logger.warn({ err }, 'Telegram callback: failed to edit message');
        }
      } else {
        try {
          const msg = cb.message;
          if (msg) {
            await bot.api.editMessageText(msg.chat.id, msg.message_id,
              i18n.t('telegram-approval:result.alreadyProcessed'),
              { reply_markup: undefined },
            );
          }
        } catch { /* ignore */ }
      }
    }

    if (action.type === 'agent_switch') {
      try {
        const msg = cb.message;
        if (msg) {
          await bot.api.editMessageText(msg.chat.id, msg.message_id,
            `已切换到 Agent: ${action.agentId}`,
            { reply_markup: undefined },
          );
        }
      } catch { /* ignore */ }
    }

    if (action.type === 'stop') {
      try {
        const msg = cb.message;
        if (msg) {
          await bot.api.editMessageText(msg.chat.id, msg.message_id,
            '已停止。',
            { reply_markup: undefined },
          );
        }
      } catch { /* ignore */ }
    }
  });
}

// ── Agent execution ──

async function executeAgent(
  agentInput: string,
  sessionKey: string,
  chatId: string,
  ctx: any,
  config: TelegramConfig,
  agentService: AgentService,
  logger: Logger,
  bot: Bot,
  showToolCalls: boolean,
  footerConfig?: FooterConfig,
  allowedRoots?: string[],
  deniedPatterns?: string[],
): Promise<void> {
  const chatIdNum = (ctx as any).chat?.id;
  if (!chatIdNum) return;

  // StreamControllerImpl expects a Bot-like object (calls this.bot.api.xxx)
  // grammY's ctx.api is the same as bot.api — pass the Bot instance directly.
  const streamCtrl = new StreamControllerImpl(bot, chatIdNum, config.streamIntervalMs, config.textLimit, logger);
  const dispatcher = new TelegramReplyDispatcher(bot, chatIdNum, streamCtrl, config, showToolCalls, footerConfig);

  try {
    const mediaTool = createTelegramMediaTool({
      bot,
      chatId: chatIdNum,
      allowedRoots: allowedRoots && allowedRoots.length > 0 ? allowedRoots : undefined,
      deniedPatterns: deniedPatterns && deniedPatterns.length > 0 ? deniedPatterns : undefined,
    });

    const approvalSender = createTelegramApprovalSender(bot);

    await agentService.execute(agentInput, {
      sessionId: sessionKey,
      chatId,
      messageId: String((ctx as any).message?.message_id ?? ''),
      replyDispatcherOverride: dispatcher,
      replyDispatcherFactory: () => {
        const freshStreamCtrl = new StreamControllerImpl(bot, chatIdNum, config.streamIntervalMs, config.textLimit, logger);
        return new TelegramReplyDispatcher(bot, chatIdNum, freshStreamCtrl, config, showToolCalls, footerConfig);
      },
      extraTools: [mediaTool],
      channel: 'telegram',
      computerUseImageSender: async (image) => {
        const ext = image.mimeType === 'image/jpeg' ? 'jpg' : 'png';
        const fileName = `computer-use-screenshot-${Date.now()}.${ext}`;
        await sendTelegramMediaBuffer(
          bot,
          chatIdNum,
          Buffer.from(image.data, 'base64'),
          fileName,
          image.mimeType,
        );
        return `Sent to Telegram as ${fileName}`;
      },
      channelApprovalSender: {
        sendApprovalMessage: (chatIdStr, requestId, command, risk, reason) =>
          approvalSender.sendApprovalMessage(chatIdStr, requestId, command, risk, reason),
        updateApprovalResult: (chatIdStr, messageIdStr, decision, command) =>
          approvalSender.updateApprovalResult(chatIdStr, messageIdStr, decision, command),
      },
    });
  } catch (err) {
    logger.error({ err }, 'Agent execution failed');
    try {
      await (ctx as any).reply('抱歉，处理消息时出现错误。');
    } catch { /* ignore */ }
  }
}

function runAgentInBackground(task: Promise<void>, logger: Logger): void {
  // Do not await agent execution in grammY middleware. Simple long polling
  // processes updates sequentially, so awaiting an approval-blocked agent run
  // prevents the callback_query that resolves the approval from being handled.
  task.catch((err) => {
    logger.error({ err }, 'Telegram background agent execution failed');
  });
}

// ── Helpers ──

function isAllowed(ctx: ReturnType<typeof buildMessageContext>, config: TelegramConfig): boolean {
  if (!ctx) return false;
  if (config.allowedUsers.length === 0) return true;
  return config.allowedUsers.includes(ctx.message.senderId);
}

function isGroup(ctx: ReturnType<typeof buildMessageContext>): boolean {
  const chatType = ctx?.message.replyMeta?.chatType as string;
  return chatType === 'group' || chatType === 'supergroup';
}

function isMentioningBot(ctx: any, botUsername: string): boolean {
  const entities = ctx.message?.entities ?? [];
  const text = ctx.message?.text ?? '';
  return entities.some((e: any) =>
    e.type === 'mention' &&
    text.slice(e.offset, e.offset + e.length) === `@${botUsername}`
  );
}

function isReplyToBot(ctx: any, botUsername: string): boolean {
  const replyTo = ctx.message?.reply_to_message;
  return replyTo?.from?.username === botUsername || replyTo?.from?.is_bot === true;
}

async function handleStart(ctx: any): Promise<void> {
  await ctx.reply(
    '🤖 <b>OhMyAgent Assistant</b>\n\n' +
    'Send me a message to start a conversation.\n\n' +
    '<b>Commands:</b>\n' +
    '/agent — List / switch agents\n' +
    '/stop — Stop current response\n' +
    '/clear — Clear session history\n' +
    '/new — Start fresh session\n' +
    '/skill — List skills\n' +
    '/cron — Manage cron jobs\n' +
    '/steer — Steer running agent\n' +
    '/btw — Inject follow-up message\n' +
    '/extension — List extensions',
    { parse_mode: 'HTML' },
  );
}
