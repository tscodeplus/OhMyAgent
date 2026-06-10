/**
 * ohmyagent login [provider]
 *
 * Interactive OAuth login for AI subscription providers.
 * Supports: anthropic, github-copilot, openai-codex
 */

import { createInterface } from 'node:readline';
import { getOAuthProvider, getOAuthProviders } from '../../pi-mono/ai/utils/oauth/index.js';
import type { OAuthLoginCallbacks } from '../../pi-mono/ai/utils/oauth/types.js';
import { SubscriptionService } from '../../app/subscription/subscription-service.js';
import { DATA_DIR } from '../config.js';

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

export async function loginCommand(providerId?: string): Promise<void> {
  const PROVIDERS = getOAuthProviders();

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    // ── Provider selection ──────────────────────────────────────────

    if (!providerId) {
      console.log('');
      for (let i = 0; i < PROVIDERS.length; i++) {
        console.log(`  ${i + 1}. ${PROVIDERS[i].name}`);
      }
      console.log('');

      const choice = await prompt(rl, `选择提供者 (1-${PROVIDERS.length}): `);
      const index = parseInt(choice, 10) - 1;
      if (index < 0 || index >= PROVIDERS.length) {
        console.error('无效选择');
        process.exit(1);
      }
      providerId = PROVIDERS[index].id;
    }

    const provider = getOAuthProvider(providerId);
    if (!provider) {
      console.error(`未知提供者: ${providerId}`);
      console.error('运行 ohmyagent --help 查看可用提供者');
      process.exit(1);
    }

    // ── Build callbacks for interactive terminal I/O ─────────────────

    const callbacks: OAuthLoginCallbacks = {
      onAuth: (info) => {
        console.log(`\n在浏览器中打开此链接:\n${info.url}`);
        if (info.instructions) console.log(info.instructions);
        console.log();
      },

      onDeviceCode: (info) => {
        console.log(`\n在浏览器中打开此链接:\n${info.verificationUri}`);
        console.log(`输入设备码: ${info.userCode}`);
        if (info.expiresInSeconds) {
          const mins = Math.round(info.expiresInSeconds / 60);
          console.log(`代码 ${mins} 分钟后过期`);
        }
        console.log();
      },

      onPrompt: async (p) => {
        return await prompt(rl, `${p.message}${p.placeholder ? ` (${p.placeholder})` : ''}: `);
      },

      onSelect: async (p) => {
        console.log(`\n${p.message}`);
        for (let i = 0; i < p.options.length; i++) {
          console.log(`  ${i + 1}. ${p.options[i].label}`);
        }
        const choice = await prompt(rl, `输入数字 (1-${p.options.length}): `);
        const index = parseInt(choice, 10) - 1;
        if (index < 0 || index >= p.options.length) {
          console.error('无效选择，已取消');
          return undefined as unknown as string;
        }
        return p.options[index]?.id ?? undefined;
      },

      onProgress: (msg) => {
        console.log(`  ${msg}`);
      },

      onManualCodeInput: async () => {
        return await prompt(rl, '粘贴授权码或回调链接: ');
      },
    };

    // ── Execute login ───────────────────────────────────────────────

    console.log(`正在登录 ${provider.name}...`);
    const service = new SubscriptionService({ dataDir: DATA_DIR });
    const credentials = await service.login(providerId, callbacks);

    console.log(`\n✓ 登录成功！凭证已保存到 ${DATA_DIR}/auth.json`);
    const expiresStr = new Date(credentials.expires).toLocaleString();
    console.log(`  过期时间: ${expiresStr}`);
  } finally {
    rl.close();
  }
}
