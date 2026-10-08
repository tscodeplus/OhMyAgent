import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { apiPost } from '../../extensions/channel-wechat/wechat-api.js';
import { WechatPoller } from '../../extensions/channel-wechat/wechat-poller.js';
import type { ILMessage } from '../../extensions/channel-wechat/wechat-types.js';

vi.mock('../../extensions/channel-wechat/wechat-api.js', () => ({
  apiPost: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

function message(clientId: string): ILMessage {
  return {
    client_id: clientId,
    from_user_id: 'user-1',
    context_token: `context-${clientId}`,
    item_list: [{ type: 1, text_item: { text: clientId } }],
  };
}

describe('WechatPoller batch delivery', () => {
  it('retains the cursor on handler failure and skips already completed messages on retry', async () => {
    const cursorDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-poller-test-'));
    const batch = [message('first'), message('second')];
    vi.mocked(apiPost).mockResolvedValue({
      msgs: batch,
      get_updates_buf: 'cursor-after-batch',
    });
    const poller = new WechatPoller(
      'https://ilink.example',
      'bot-token',
      cursorDir,
      pino({ level: 'silent' }),
    );
    const handled: string[] = [];
    let secondAttempts = 0;

    try {
      await poller.start(async (msg) => {
        handled.push(msg.client_id);
        if (msg.client_id === 'second' && secondAttempts++ === 0) {
          throw new Error('temporary handler failure');
        }
        if (msg.client_id === 'second') poller.stop();
      });

      expect(apiPost).toHaveBeenCalledTimes(2);
      expect(handled).toEqual(['first', 'second', 'second']);

      const cursorPath = (await fs.readdir(cursorDir)).find((name) => name.startsWith('sync-'));
      expect(cursorPath).toBeDefined();
      const cursor = JSON.parse(await fs.readFile(path.join(cursorDir, cursorPath!), 'utf-8')) as {
        get_updates_buf: string;
      };
      expect(cursor.get_updates_buf).toBe('cursor-after-batch');

      const receiptPath = (await fs.readdir(cursorDir)).find((name) =>
        name.startsWith('processed-'),
      );
      expect(receiptPath).toBeDefined();
      const receipts = JSON.parse(
        await fs.readFile(path.join(cursorDir, receiptPath!), 'utf-8'),
      ) as {
        cursor: string;
        messageIds: string[];
      };
      expect(receipts).toEqual({ cursor: 'cursor-after-batch', messageIds: [] });
    } finally {
      poller.stop();
      await fs.rm(cursorDir, { recursive: true, force: true });
    }
  });
});
