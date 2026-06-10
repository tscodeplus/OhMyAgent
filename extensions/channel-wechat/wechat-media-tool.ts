/**
 * WeChat media send tool — allows the agent to send images/files to a WeChat user.
 *
 * Uses the existing iLink CDN upload pipeline (uploadMedia + sendMessage).
 */

import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import path from 'path';
import os from 'os';
import { Type } from 'typebox';
import { i18n } from '../../src/i18n/index.js';
import { isWithinRoot } from '../../src/shared/path-utils.js';
import type { AgentTool } from '../../src/pi-mono/agent/types.js';
import { uploadMedia } from './wechat-media.js';
import { sendMessage } from './wechat-sender.js';
import { MessageItemType, UploadMediaType } from './wechat-types.js';
import type { Logger } from 'pino';

export interface WechatMediaToolOptions {
  apiBase: string;
  botToken: string;
  toUserId: string;
  contextToken: string;
  aesKey?: string;
  logger: Logger;
  allowedRoots?: string[];
  deniedPatterns?: string[];
}

function matchGlob(filePath: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(filePath);
}

export function createWechatMediaTool(options: WechatMediaToolOptions): AgentTool<any> {
  const { apiBase, botToken, toUserId, contextToken, logger } = options;

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
    name: 'wechat_send_media',
    label: 'Send local file or image to the user via WeChat',
    description:
      'Send a local image, picture, photo, screenshot, or any file on disk to the WeChat user you are chatting with. Use this tool whenever the user asks you to send a file, picture, or image. Provide the full absolute path of the file on the local filesystem.',
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

        const ext = path.extname(filePath).toLowerCase();
        const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
        const mediaType = imageExts.includes(ext)
          ? UploadMediaType.IMAGE
          : UploadMediaType.FILE;

        const mediaParam = await uploadMedia(
          apiBase,
          botToken,
          filePath,
          mediaType,
          toUserId,
          options.aesKey,
          logger,
        );

        const msgType = imageExts.includes(ext)
          ? MessageItemType.IMAGE
          : MessageItemType.FILE;

        const itemList: unknown[] = msgType === MessageItemType.IMAGE
          ? [{
              type: MessageItemType.IMAGE,
              image_item: {
                media: mediaParam,
                mid_size: mediaParam.fileSizeCiphertext,
              },
            }]
          : [{
              type: MessageItemType.FILE,
              file_item: {
                media: mediaParam,
                file_name: path.basename(filePath),
                len: String(mediaParam.fileSizeCiphertext ?? 0),
              },
            }];

        await sendMessage(apiBase, botToken, {
          toUserId,
          contextToken,
          msgType,
          msgContent: '',
          itemList,
        });

        const fileName = path.basename(filePath);
        return { content: [{ type: 'text' as const, text: `File sent: ${fileName}` }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed to send media: ${err.message}` }] };
      }
    },
  } as AgentTool<any>;
}

export async function sendWechatMediaBuffer(
  options: WechatMediaToolOptions,
  buffer: Buffer,
  fileName: string,
  mimeType: string,
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ohmyagent-wechat-media-'));
  const filePath = path.join(tempDir, fileName);
  try {
    await writeFile(filePath, buffer);
    const mediaType = mimeType.startsWith('image/')
      ? UploadMediaType.IMAGE
      : UploadMediaType.FILE;
    const mediaParam = await uploadMedia(
      options.apiBase,
      options.botToken,
      filePath,
      mediaType,
      options.toUserId,
      options.aesKey,
      options.logger,
    );
    const msgType = mimeType.startsWith('image/')
      ? MessageItemType.IMAGE
      : MessageItemType.FILE;
    const itemList: unknown[] = msgType === MessageItemType.IMAGE
      ? [{
          type: MessageItemType.IMAGE,
          image_item: {
            media: mediaParam,
            mid_size: mediaParam.fileSizeCiphertext,
          },
        }]
      : [{
          type: MessageItemType.FILE,
          file_item: {
            media: mediaParam,
            file_name: fileName,
            len: String(mediaParam.fileSizeCiphertext ?? 0),
          },
        }];

    await sendMessage(options.apiBase, options.botToken, {
      toUserId: options.toUserId,
      contextToken: options.contextToken,
      msgType,
      msgContent: '',
      itemList,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
