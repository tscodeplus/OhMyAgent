/**
 * Telegram media send tool — allows the agent to send images/files to a Telegram chat.
 *
 * Uses grammY's InputFile to send local files directly via the Telegram Bot API.
 */

import { readFile } from 'fs/promises';
import path from 'path';
import os from 'os';
import { isWithinRoot } from '../../src/shared/path-utils.js';
import { Type } from 'typebox';
import type { AgentTool } from '../../src/pi-mono/agent/types.js';
import { InputFile } from 'grammy';
import type { Bot } from 'grammy';

export interface TelegramMediaToolOptions {
  bot: Bot;
  chatId: number;
  allowedRoots?: string[];
  deniedPatterns?: string[];
}

function matchGlob(filePath: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(filePath);
}

export function createTelegramMediaTool(options: TelegramMediaToolOptions): AgentTool<any> {
  const { bot, chatId } = options;

  const allowedRoots = [process.cwd()];
  if (options.allowedRoots && options.allowedRoots.length > 0) {
    for (const r of options.allowedRoots) {
      const resolved = path.resolve(r);
      if (!allowedRoots.includes(resolved)) {
        allowedRoots.push(resolved);
      }
    }
  }
  const deniedPatterns = options.deniedPatterns ?? [];

  return {
    name: 'telegram_send_media',
    label: 'Send local file or image to the user via Telegram',
    description:
      'Send a local image, picture, photo, screenshot, or any file on disk to the Telegram user you are chatting with. Use this tool whenever the user asks you to send a file, picture, or image. Provide the full absolute path of the file on the local filesystem.',
    parameters: Type.Object({
      filePath: Type.String({ description: 'The absolute path of the file to send, e.g. /tmp/image.png' }),
    }),
    execute: async (_toolCallId: string, params: { filePath: string }) => {
      try {
        const rawPath = params.filePath;

        let filePath: string;
        if (rawPath.startsWith('~')) {
          filePath = path.resolve(os.homedir(), rawPath.slice(rawPath.startsWith('~/') ? 2 : 1));
        } else {
          filePath = path.resolve(rawPath);
        }

        for (const pattern of deniedPatterns) {
          if (matchGlob(filePath, pattern) || matchGlob(path.basename(filePath), pattern)) {
            return { content: [{ type: 'text' as const, text: `Access denied: ${rawPath}` }] };
          }
        }

        // Allowed roots check handled by before-tool-call approval hooks

        let buffer: Buffer;
        try {
          buffer = await readFile(filePath);
        } catch (err: any) {
          if (err.code === 'ENOENT') {
            return { content: [{ type: 'text' as const, text: `File not found: ${filePath}` }] };
          }
          return { content: [{ type: 'text' as const, text: `Error reading file: ${err.message}` }] };
        }

        const fileName = path.basename(filePath);
        const ext = path.extname(fileName).toLowerCase();
        const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];

        // grammY supports sending Buffer as InputFile with a filename
        const inputFile = new InputFile(buffer, fileName);

        if (imageExts.includes(ext)) {
          void await bot.api.sendPhoto(chatId, inputFile);
          return { content: [{ type: 'text' as const, text: `Image sent: ${fileName}` }] };
        }

        void await bot.api.sendDocument(chatId, inputFile);
        return { content: [{ type: 'text' as const, text: `File sent: ${fileName}` }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed to send media: ${err.message}` }] };
      }
    },
  } as AgentTool<any>;
}

export async function sendTelegramMediaBuffer(
  bot: Bot,
  chatId: number,
  buffer: Buffer,
  fileName: string,
  mimeType: string,
): Promise<void> {
  const inputFile = new InputFile(buffer, fileName);
  if (mimeType.startsWith('image/')) {
    await bot.api.sendPhoto(chatId, inputFile);
    return;
  }
  await bot.api.sendDocument(chatId, inputFile);
}
