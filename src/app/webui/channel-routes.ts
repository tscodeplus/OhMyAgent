/**
 * Channel Status API Routes
 */

import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../types.js';

interface ChannelRouteConfig {
  getConfig: () => AppConfig;
}

export function registerChannelRoutes(app: FastifyInstance, cfg: ChannelRouteConfig): void {
  app.get('/api/channels/status', async (_request, reply) => {
    const config = cfg.getConfig();

    const channels = [
      {
        name: 'Feishu',
        key: 'feishu',
        status: config.feishu?.enabled ? ('running' as const) : ('stopped' as const),
        mode: config.feishu?.wsEnabled ? 'WebSocket' : 'Webhook',
      },
      {
        name: 'Telegram',
        key: 'telegram',
        status: config.telegram?.enabled ? ('running' as const) : ('stopped' as const),
        mode: config.telegram?.mode || 'polling',
      },
      {
        name: 'WeChat',
        key: 'wechat',
        status: config.wechat?.enabled ? ('running' as const) : ('stopped' as const),
        mode: 'API',
      },
      {
        name: 'QQ',
        key: 'qq',
        status: config.qq?.enabled ? ('running' as const) : ('stopped' as const),
        mode: 'API',
      },
    ];

    return reply.send({ channels });
  });

  app.post('/api/channels/:name/restart', async (request, reply) => {
    const { name } = request.params as { name: string };
    // This is a placeholder — full channel restart would need to wire into ChannelManager
    return reply.send({ ok: true, message: `Channel ${name} restart requested (hot reload may apply)` });
  });
}
