/**
 * ohmyagent logout [provider]
 *
 * Remove saved OAuth credentials for a subscription provider.
 */

import { createInterface } from 'node:readline';
import { SubscriptionService } from '../../app/subscription/subscription-service.js';
import { DATA_DIR } from '../config.js';

export async function logoutCommand(providerId?: string): Promise<void> {
  const service = new SubscriptionService({ dataDir: DATA_DIR });

  if (!providerId) {
    // Show list of logged-in providers for interactive selection
    const statuses = await service.listStatuses();
    const loggedIn = statuses.filter((s) => s.loggedIn);

    if (loggedIn.length === 0) {
      console.log('没有已登录的订阅');
      return;
    }

    if (loggedIn.length === 1) {
      providerId = loggedIn[0].providerId;
    } else {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        console.log('\n已登录的提供者:');
        for (let i = 0; i < loggedIn.length; i++) {
          const exp = loggedIn[i].expiresAt
            ? ` (过期: ${new Date(loggedIn[i].expiresAt!).toLocaleString()})`
            : '';
          console.log(`  ${i + 1}. ${loggedIn[i].providerName}${exp}`);
        }
        console.log();

        const choice = await new Promise<string>((resolve) =>
          rl.question(`选择要登出的提供者 (1-${loggedIn.length}): `, resolve),
        );
        const index = parseInt(choice, 10) - 1;
        if (index < 0 || index >= loggedIn.length) {
          console.error('无效选择');
          process.exit(1);
        }
        providerId = loggedIn[index].providerId;
      } finally {
        rl.close();
      }
    }
  }

  await service.logout(providerId);
  console.log(`✓ 已从 ${providerId} 登出`);
}
