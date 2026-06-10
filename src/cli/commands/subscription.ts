/**
 * ohmyagent subscription <list|status> [providerId]
 *
 * View subscription status for OAuth-based AI providers.
 */

import { SubscriptionService } from '../../app/subscription/subscription-service.js';
import { DATA_DIR } from '../config.js';

export async function subscriptionCommand(action: string, args: string[]): Promise<void> {
  const service = new SubscriptionService({ dataDir: DATA_DIR });

  switch (action) {
    case 'list': {
      const statuses = await service.listStatuses();

      if (statuses.length === 0) {
        console.log('没有可用的订阅提供者');
        return;
      }

      // Column widths
      const nameW = Math.max(...statuses.map((s) => s.providerName.length), 12);
      const statusW = 10;
      const expiresW = 20;

      console.log('');
      console.log(
        `${'提供者'.padEnd(nameW)}  ${'状态'.padEnd(statusW)}  ${'过期时间'.padEnd(expiresW)}`,
      );
      console.log(`${'─'.repeat(nameW)}  ${'─'.repeat(statusW)}  ${'─'.repeat(expiresW)}`);

      for (const s of statuses) {
        const statusStr = s.loggedIn ? '✓ 已登录' : '✗ 未登录';
        const expiresStr = s.expiresAt
          ? new Date(s.expiresAt).toLocaleString()
          : '—';
        console.log(
          `${s.providerName.padEnd(nameW)}  ${statusStr.padEnd(statusW)}  ${expiresStr.padEnd(expiresW)}`,
        );
      }
      console.log('');
      break;
    }

    case 'status': {
      const providerId = args[0];
      if (!providerId) {
        console.error('用法: ohmyagent subscription status <providerId>');
        console.error('运行 ohmyagent subscription list 查看可用提供者');
        process.exit(1);
      }

      const status = await service.getStatus(providerId);
      console.log('');
      console.log(`提供者:   ${status.providerName}`);
      console.log(`ID:       ${status.providerId}`);
      console.log(`状态:     ${status.loggedIn ? '已登录 ✓' : '未登录 ✗'}`);
      if (status.expiresAt) {
        const d = new Date(status.expiresAt);
        const remaining = Math.max(0, status.expiresAt - Date.now());
        const days = Math.floor(remaining / 86400000);
        const hours = Math.floor((remaining % 86400000) / 3600000);
        console.log(`过期时间: ${d.toLocaleString()} (剩余 ${days}d ${hours}h)`);
      }
      console.log('');
      break;
    }

    default:
      console.error(`未知子命令: ${action}`);
      console.error('用法: ohmyagent subscription <list|status>');
      process.exit(1);
  }
}
