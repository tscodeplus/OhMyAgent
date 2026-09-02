/**
 * channel-wechat extension entry point.
 *
 * Registers a ChannelAdapter that bridges Tencent iLink protocol messages
 * into OhMyAgent's unified channel/agent pipeline.
 *
 * Supports two modes:
 * 1. **Auto-start** — a `botToken` is present in config; the poller starts
 *    immediately on `adapter.start()`.
 * 2. **QR login** — no `botToken` yet; REST endpoints are registered on the
 *    Fastify server for QR code generation, scan-status polling, and bot
 *    activation (POST /wechat/login, /wechat/login/poll, /wechat/login/start).
 */

import type { ExtensionAPI } from '../../src/extensions/types.js';
import type { CommandDeps } from '../../src/commands/command-handler.js';
import type { ChannelAdapter, ChannelContext, ReplyContent } from '../../src/channel/types.js';
import type { AgentService } from '../../src/agent/agent-service.js';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { CronDeliveryRegistry } from '../../src/cron/delivery-registry.js';
import { resolveWechatConfig } from './wechat-config.js';
import type { WechatConfig } from './wechat-types.js';
import { WechatPoller } from './wechat-poller.js';
import { setupMessageHandlers, getTokenForCron } from './message-handler.js';
import { getQrcode, pollQrcodeStatus } from './wechat-auth.js';
import { sendReply as sendWechatReply } from './send-message.js';
import { sendChunkedText } from './wechat-sender.js';
import { notifyStop } from './wechat-api.js';

export default function (api: ExtensionAPI) {
  const config = api.getConfig();
  const logger = api.getLogger();

  // WeChat uses a two-phase startup:
  // 1. Always register QR login routes (even without botToken / enabled=false)
  // 2. The channel adapter starts only after a token is obtained
  const wechatConfig = resolveWechatConfig(config.wechat ?? {});

  // Get shared services
  const agentService = api.getService<AgentService>('agentService');
  if (!agentService) {
    logger.error('AgentService not found — channel-wechat requires it');
    return;
  }

  const server = api.getService<FastifyInstance>('server');
  const commandDeps = api.getService<CommandDeps>('commandDeps');

  // Build a safe CommandDeps fallback when the real one is unavailable.
  // SAFETY: agentService is the same concrete AgentService instance; CommandDeps
  // narrows it opaquely so the tool layer cannot depend on its concrete type here.
  const deps: CommandDeps | undefined = commandDeps ?? {
    agentService: agentService as unknown as CommandDeps['agentService'],
    skillRegistry: undefined,
    cronService: undefined,
    feishuClient: undefined,
    agentManager: undefined,
    extensionManager: undefined,
  };

  // Register WeChat cron delivery client
  const cronRegistry = api.getService<CronDeliveryRegistry>('cronDeliveryRegistry');
  if (cronRegistry) {
    cronRegistry.register('wechat', {
      async deliver({ chatId, text, modelLabel, agentName, footer: footerConfig }) {
        if (!wechatConfig.botToken) {
          logger.warn('Cannot deliver cron result - WeChat bot token not available');
          return;
        }
        const tokenEntry = getTokenForCron(chatId);
        if (!tokenEntry) {
          logger.warn(
            { chatId },
            'Cannot deliver cron result - no valid WeChat context token (expired or never received)',
          );
          return;
        }
        const parts: string[] = [];
        if (footerConfig.showAgentName && agentName) parts.push(agentName);
        if (footerConfig.showModel && modelLabel) parts.push(modelLabel);
        parts.push(new Date().toLocaleString('zh-CN'));
        const footer = `\n\n${parts.join(' · ')}`;
        const sent = await sendChunkedText(
          wechatConfig.apiBase,
          wechatConfig.botToken,
          tokenEntry.toUserId,
          tokenEntry.token,
          text + footer,
          wechatConfig.textLimit,
          logger,
        );
        if (sent.length === 0) {
          throw new Error('WeChat cron delivery: all chunks failed to send');
        }
      },
    });
    logger.info('WeChat cron delivery client registered');
  }

  // ── Module-level state ──
  let poller: WechatPoller | null = null;
  let started = false;
  /**
   * In-flight startWechatBot() from adapter.start(). Until it resolves,
   * `poller` is still null — an activation that reads `poller` in that window
   * would conclude "no poller running" and start a SECOND long-poller sharing
   * the same cursor file (each overwriting the other's cursor every poll).
   */
  let pendingStart: Promise<WechatPoller> | null = null;

  // ── QR code login REST endpoints (always registered for initial auth / re-auth) ──
  if (server) {
    registerQrRoutes(
      server,
      wechatConfig,
      logger,
      agentService,
      deps,
      api,
      () => poller,
      (p) => {
        poller = p;
      },
      () => pendingStart,
    );
  }

  // ── ChannelAdapter ──
  const adapter: ChannelAdapter = {
    id: 'wechat',

    async start(): Promise<void> {
      if (started) {
        logger.warn('WeChat adapter already started');
        return;
      }

      if (wechatConfig.botToken) {
        const starting = startWechatBot(wechatConfig, agentService, deps, logger, api, () => {
          // Session expired (errcode -14): the poller stopped itself. Clear the
          // handle so adapter status reflects reality and re-auth goes through
          // the QR login routes (report #11h — channel used to go silent).
          poller = null;
          started = false;
        });
        pendingStart = starting;
        starting
          .then((p) => {
            poller = p;
            started = true;
          })
          .catch((err: unknown) => {
            logger.error({ err }, 'Failed to start WeChat bot');
          })
          .finally(() => {
            pendingStart = null;
          });
      } else {
        logger.info('WeChat bot token not set — waiting for QR login');
      }
    },

    async stop(): Promise<void> {
      // Notify iLink that bot is stopping
      if (wechatConfig.botToken) {
        try {
          await notifyStop(wechatConfig.apiBase, wechatConfig.botToken);
        } catch (err: unknown) {
          logger.warn({ err }, 'Failed to notify stop');
        }
      }

      if (poller) {
        poller.stop();
        poller = null;
      }
      started = false;
    },

    onReceive(_handler: (ctx: ChannelContext) => Promise<void>): void {
      // Handlers are wired in startWechatBot() via setupMessageHandlers.
    },

    async sendReply(ctx: ChannelContext, reply: ReplyContent): Promise<void> {
      const contextToken = ctx.message.replyMeta?.contextToken as string | undefined;
      const toUserId = ctx.message.replyMeta?.fromUserId as string | undefined;

      if (!contextToken || !toUserId) {
        logger.warn(
          { replyMeta: ctx.message.replyMeta },
          'Cannot determine context token or user ID for WeChat reply',
        );
        return;
      }

      if (!wechatConfig.botToken) {
        logger.warn('WeChat bot token not available for reply');
        return;
      }

      await sendWechatReply(
        wechatConfig.apiBase,
        wechatConfig.botToken,
        reply,
        contextToken,
        toUserId,
        wechatConfig,
        logger,
      );
    },
  };

  api.registerChannel(adapter);
  logger.info('channel-wechat registered');
}

// ---------------------------------------------------------------------------
// QR login routes
// ---------------------------------------------------------------------------

function registerQrRoutes(
  server: FastifyInstance,
  wechatConfig: WechatConfig,
  logger: Logger,
  agentService: AgentService,
  deps: CommandDeps | undefined,
  api: ExtensionAPI,
  getPoller: () => WechatPoller | null,
  setPoller: (p: WechatPoller | null) => void,
  getPendingStart: () => Promise<WechatPoller> | null,
): void {
  /**
   * Activations run strictly one after another. Concurrent QR confirmations
   * (two browser tabs, or /wechat/login/poll racing POST /wechat/login/start)
   * would otherwise both observe "no poller" and start a second long-poller
   * over the same cursor file.
   */
  let activationChain: Promise<void> = Promise.resolve();

  function activateBot(botToken: string, source: string): Promise<void> {
    const run = activationChain.then(
      () => doActivateBot(botToken, source),
      () => doActivateBot(botToken, source),
    );
    // Never let a failed activation poison the chain.
    activationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // Persist the bot token to config + .env and (re)start the poller.
  // Shared by /wechat/login/poll (server-side auto-activation on scan confirm),
  // POST /wechat/login/start (token-authenticated) and the /api/channels/wechat/qr/start wrapper.
  async function doActivateBot(botToken: string, source: string): Promise<void> {
    wechatConfig.botToken = botToken;
    try {
      const fs = await import('node:fs/promises');
      const envPath = '.env';
      let envContent = '';
      try {
        envContent = await fs.readFile(envPath, 'utf-8');
      } catch {
        logger.warn('No existing .env file to read for WeChat token update');
      }
      const newLine = `WECHAT_BOT_TOKEN=${botToken}`;
      if (envContent.includes('WECHAT_BOT_TOKEN=')) {
        // Use function-form replacement so `$` sequences in the token are
        // inserted literally instead of being interpreted as replacement patterns.
        envContent = envContent.replace(/WECHAT_BOT_TOKEN=.*/g, () => newLine);
      } else {
        envContent += '\n' + newLine + '\n';
      }
      await fs.writeFile(envPath, envContent, 'utf-8');
      logger.info({ source }, 'WeChat bot token persisted to .env');
    } catch (e) {
      logger.warn({ err: e }, 'Failed to persist WeChat token to .env');
    }

    // Stop old poller if running (token might have expired), then start fresh
    await getPendingStart()?.catch(() => {
      /* the failed start logged itself */
    });
    const old = getPoller();
    if (old) {
      try {
        old.stop();
      } catch {
        logger.warn('Failed to stop old WeChat poller during restart');
      }
      setPoller(null);
    }
    const p = await startWechatBot(wechatConfig, agentService, deps, logger, api, (info) => {
      logger.warn(
        info,
        'WeChat session expired — poller stopped, re-authenticate via QR login (/wechat/login)',
      );
      setPoller(null);
    });
    setPoller(p);
  }

  // GET /wechat/login — show QR code page (browser-friendly)
  // GET /wechat/login — show QR code page (browser-friendly)
  server.get('/wechat/login', async (_req, reply) => {
    try {
      logger.info('QR login: requesting QR code from iLink');
      const result = await getQrcode(wechatConfig.apiBase);
      logger.info({ qrcodeId: result.qrcodeId }, 'QR login: got QR code');
      const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>WeChat Login</title>
<style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;font-family:sans-serif;background:#f5f5f5}
img{max-width:300px;border:2px solid #ccc;border-radius:8px;margin:20px}
#status{margin:10px;padding:10px 20px;border-radius:4px}
.waiting{background:#fff3cd;color:#856404}
.scanned{background:#cce5ff;color:#004085}
.confirmed{background:#d4edda;color:#155724}
.expired{background:#f8d7da;color:#721c24}
.error{background:#f8d7da;color:#721c24}</style></head>
<body>
<h3>&#x5FAE;&#x4FE1;&#x626B;&#x7801;&#x767B;&#x5F55;</h3>
<img src="${result.qrcodeImageDataUrl}" alt="QR Code" id="qr">
<div id="status" class="waiting">&#x8BF7;&#x4F7F;&#x7528;&#x5FAE;&#x4FE1;&#x626B;&#x7801;</div>
<script>
const statusEl = document.getElementById('status');
var labels = { waiting: '\u{1F4F7} 请使用微信扫码', scanned: '\u{1F440} 已扫码，请在手机上确认', confirmed: '✅ 登录成功！', expired: '⏳ 二维码已过期，刷新页面重试', error: '⚠️ 网络错误，正在重试...' };
function poll() {
  fetch('/wechat/login/poll', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({qrcodeId:'${result.qrcodeId}'}) })
    .then(r => r.json())
    .then(data => {
      statusEl.className = data.status || 'waiting';
      statusEl.textContent = labels[data.status] || data.status;
      // Bot activation happens server-side on confirm (poll response carries no token).
      if (data.status === 'confirmed') {
        statusEl.textContent = '✅ 登录成功！Bot 已启动';
      } else if (data.status !== 'expired') {
        setTimeout(poll, 2000);
      }
    })
    .catch(() => setTimeout(poll, 3000));
}
setTimeout(poll, 1000);
</script></body></html>`;
      return reply.type('text/html').send(html);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'Failed to get WeChat QR code');
      return reply.status(500).type('text/html').send(`<h3>Error</h3><p>${message}</p>`);
    }
  });

  // POST /wechat/login — request a new QR code (API)
  server.post('/wechat/login', async (_req, reply) => {
    try {
      const result = await getQrcode(wechatConfig.apiBase);
      return reply.send({ ok: true, ...result });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'Failed to get WeChat QR code');
      return reply.status(500).send({ ok: false, error: message });
    }
  });

  // POST /wechat/login/poll — long-poll QR scan status
  server.post('/wechat/login/poll', async (req, reply) => {
    try {
      const body = req.body as { qrcodeId?: string };
      if (!body.qrcodeId) {
        return reply.status(400).send({ ok: false, error: 'qrcodeId required' });
      }

      logger.info({ qrcodeId: body.qrcodeId }, 'QR poll: starting');

      // Abort polling when the HTTP request is aborted (client disconnect)
      const controller = new AbortController();
      req.raw.on('close', () => controller.abort());

      const result = await pollQrcodeStatus(wechatConfig.apiBase, body.qrcodeId, controller.signal);
      logger.info({ status: result.status }, 'QR poll: result');
      if (result.status === 'confirmed' && result.botToken) {
        // Activate the bot server-side — the botToken must NOT be returned to
        // (potentially unauthenticated) poll callers, and the scan-page flow
        // no longer needs a separate authenticated /login/start round-trip.
        await activateBot(result.botToken, 'QR login confirmed');
        return reply.send({ ok: true, status: 'confirmed' });
      }
      return reply.send(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'Failed to poll WeChat QR status');
      return reply.status(500).send({ ok: false, error: message });
    }
  });

  // POST /wechat/login/start — store bot token and start the bot (token-authenticated;
  // QR scan flow auto-activates server-side via /wechat/login/poll)
  server.post('/wechat/login/start', async (req, reply) => {
    try {
      const body = req.body as { botToken?: string };
      if (!body.botToken) {
        return reply.status(400).send({ ok: false, error: 'botToken required' });
      }

      await activateBot(body.botToken, 'login/start');

      return reply.send({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'Failed to start WeChat bot from QR login');
      return reply.status(500).send({ ok: false, error: message });
    }
  });

  // POST /api/channels/wechat/qr — API-friendly wrapper for QR code generation
  server.post('/api/channels/wechat/qr', async (_req, reply) => {
    try {
      const result = await getQrcode(wechatConfig.apiBase);
      return reply.send({
        ok: true,
        sessionId: result.qrcodeId,
        qrcodeImageDataUrl: result.qrcodeImageDataUrl,
        instructions: 'Use WeChat to scan the QR code and confirm the login on your device.',
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'Failed to get WeChat QR code via API');
      return reply.status(500).send({ ok: false, error: message });
    }
  });

  // POST /api/channels/wechat/qr/poll — API-friendly wrapper for QR status polling
  server.post('/api/channels/wechat/qr/poll', async (req, reply) => {
    try {
      const body = req.body as { sessionId?: string };
      if (!body.sessionId) {
        return reply.status(400).send({ ok: false, error: 'sessionId required' });
      }
      const controller = new AbortController();
      req.raw.on('close', () => controller.abort());
      const result = await pollQrcodeStatus(
        wechatConfig.apiBase,
        body.sessionId,
        controller.signal,
      );
      return reply.send(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'Failed to poll WeChat QR status via API');
      return reply.status(500).send({ ok: false, error: message });
    }
  });

  // POST /api/channels/wechat/qr/start — API-friendly wrapper for bot activation
  server.post('/api/channels/wechat/qr/start', async (req, reply) => {
    try {
      const body = req.body as { botToken?: string };
      if (!body.botToken) {
        return reply.status(400).send({ ok: false, error: 'botToken required' });
      }

      await activateBot(body.botToken, 'api/channels/wechat/qr/start');

      return reply.send({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'Failed to start WeChat bot from API');
      return reply.status(500).send({ ok: false, error: message });
    }
  });

  logger.info('WeChat QR login routes registered at /wechat/login*');
}

// ---------------------------------------------------------------------------
// Bot startup
// ---------------------------------------------------------------------------

/**
 * Create a WechatPoller, wire message handlers, and start polling.
 */
async function startWechatBot(
  config: WechatConfig,
  agentService: AgentService,
  deps: CommandDeps | undefined,
  logger: Logger,
  api: ExtensionAPI,
  onSessionExpired?: (info: { errcode: number; errmsg?: string }) => void,
): Promise<WechatPoller> {
  if (!config.botToken) {
    throw new Error('Cannot start WeChat bot without a bot token');
  }

  const poller = new WechatPoller(
    config.apiBase,
    config.botToken,
    config.cursorDir,
    logger,
    onSessionExpired,
  );

  // v5 P2: Build STT transcriber for WeChat voice messages
  let sttTranscriber: ((path: string, lang?: string) => Promise<string>) | undefined;
  const appConfig = api.getConfig();
  const sttCfg = appConfig.multimodal?.stt;
  if (sttCfg?.enabled && sttCfg.providers?.length) {
    const { createSTTProviders, transcribeWithFallback } =
      await import('../../src/media-providers/stt/factory.js');
    const sttProviders = createSTTProviders(sttCfg.providers);
    if (sttProviders.length > 0) {
      sttTranscriber = async (audioPath: string, language?: string) => {
        const result = await transcribeWithFallback(sttProviders, {
          audioPath,
          language: language ?? sttCfg.language ?? 'auto',
        });
        return result.text;
      };
    }
  }
  const sttHandlerConfig = sttCfg
    ? {
        enabled: sttCfg.enabled ?? false,
        autoTranscribe: sttCfg.autoTranscribe ?? true,
        language: sttCfg.language ?? 'auto',
      }
    : undefined;

  // Wire message handlers (starts polling in background)
  setupMessageHandlers(
    poller,
    { apiBase: config.apiBase, botToken: config.botToken },
    config,
    agentService,
    deps,
    logger,
    api,
    sttTranscriber,
    sttHandlerConfig,
  );

  logger.info('WeChat bot started');
  return poller;
}
