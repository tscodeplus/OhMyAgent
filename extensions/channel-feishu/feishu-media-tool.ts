/**
 * Feishu media sending tool.
 *
 * Allows the agent to upload and send images/files to the current Feishu chat.
 * The tool reads a local file, uploads it to Feishu IM storage, and sends it
 * as an image or file message.
 */

import { readFile } from 'fs/promises';
import path from 'path';
import os from 'os';
import { Type } from 'typebox';
import type { AgentTool } from '../../src/pi-mono/agent/types.js';
import { i18n } from '../../src/i18n/index.js';
import { isImageExtension, isVideoExtension, detectFileType } from './feishu-media.js';
import type { FeishuClient } from './feishu-client.js';


function matchGlob(filePath: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(filePath);
}

export interface FeishuMediaToolOptions {
  feishuClient: FeishuClient;
  /** The Feishu chat ID to send media to. */
  chatId: string;
  /** Allowed directory roots for file reading (from FILE_READ_ALLOWED_ROOTS). */
  allowedRoots?: string[];
  /** Denied file patterns (from FILE_READ_DENIED_PATTERNS). */
  deniedPatterns?: string[];
}

/**
 * Create a tool that sends local image or file to the current Feishu chat.
 *
 * The tool detects whether the file is an image (by extension) and sends it
 * as an image message or a file message accordingly.
 */
export function createFeishuMediaTool(options: FeishuMediaToolOptions) {
  const { feishuClient, chatId } = options;

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
    name: 'feishu_send_media',
    label: 'Send Media to Feishu',
    description:
      'Send images or files to the Feishu chat. Provide an absolute file path. If the path is outside allowed directories, the system will automatically show an approval card — just try to send and wait for approval. Do NOT copy files to other directories first.',
    parameters: Type.Object({
      filePath: Type.String({ description: 'Absolute path of the file to send' }),
    }),
    execute: async (_toolCallId: string, params: { filePath: string }) => {
      try {
        const rawPath = params.filePath;

        // Resolve to absolute path (expand ~)
        let filePath: string;
        if (rawPath.startsWith('~')) {
          filePath = path.resolve(os.homedir(), rawPath.slice(rawPath.startsWith('~/') ? 2 : 1));
        } else {
          filePath = path.resolve(rawPath);
        }

        // Check denied patterns (.env, *.pem, etc.)
        for (const pattern of deniedPatterns) {
          if (matchGlob(filePath, pattern) || matchGlob(path.basename(filePath), pattern)) {
            return { content: [{ type: 'text' as const, text: i18n.t('tools-media:error.accessDenied') }] };
          }
        }

        // Note: allowed roots check is handled by the v4 PolicyCenter approval hooks.
        // When called through the v4 adapter with approvalAlreadyHandled=true,
        // the path has already been approved. When called directly, the legacy check
        // would block — but extra tools are always wrapped by v4 adapter when available.

        // Read the file
        let buffer: Buffer;
        try {
          buffer = await readFile(filePath);
        } catch (err: any) {
          if (err.code === 'ENOENT') {
            return {
              content: [{ type: 'text' as const, text: i18n.t('tools-media:error.fileNotFound', { path: filePath }) }],
            };
          }
          return {
            content: [{ type: 'text' as const, text: i18n.t('tools-media:error.readError', { message: err.message }) }],
          };
        }

        const fileName = filePath.split('/').pop() ?? 'file';

        if (isImageExtension(fileName)) {
          // ─── Image path ───
          const { imageKey } = await feishuClient.uploadImage(buffer, 'message');

          const content = JSON.stringify({ image_key: imageKey });
          await feishuClient.sendMessage({
            receive_id: chatId,
            receive_id_type: 'chat_id',
            msg_type: 'image',
            content,
          });

          return {
            content: [{
              type: 'text' as const,
              text: i18n.t('tools-media:imageSent', { key: imageKey }),
            }],
          };
        }

        if (isVideoExtension(fileName)) {
          // ─── Video path ───
          const fileType = detectFileType(fileName);
          const { fileKey } = await feishuClient.uploadFile(buffer, fileName, fileType);

          const content = JSON.stringify({ file_key: fileKey });
          await feishuClient.sendMessage({
            receive_id: chatId,
            receive_id_type: 'chat_id',
            msg_type: 'media',
            content,
          });

          return {
            content: [{
              type: 'text' as const,
              text: i18n.t('tools-media:fileSent', { name: fileName, key: fileKey }),
            }],
          };
        }

        // ─── File path ───
        const fileType = detectFileType(fileName);
        const { fileKey } = await feishuClient.uploadFile(buffer, fileName, fileType);

        const content = JSON.stringify({ file_key: fileKey });
        await feishuClient.sendMessage({
          receive_id: chatId,
          receive_id_type: 'chat_id',
          msg_type: 'file',
          content,
        });

        return {
          content: [{
            type: 'text' as const,
            text: i18n.t('tools-media:fileSent', { name: fileName, key: fileKey }),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: 'text' as const,
            text: i18n.t('tools-media:error.sendFailed', { message: err.message }),
          }],
        };
      }
    },
  } as AgentTool<any>;
}
