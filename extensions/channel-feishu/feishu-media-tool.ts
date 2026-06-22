/**
 * Feishu media tools.
 *
 * - feishu_send_media: upload and send images/files to Feishu chat
 * - download_feishu_file: download file attachments from Feishu messages
 */

import { readFile, unlink, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { Type } from 'typebox';
import type { AgentTool } from '../../src/pi-mono/agent/types.js';
import { i18n } from '../../src/i18n/index.js';
import { isImageExtension, isVideoExtension, detectFileType, getVideoDuration } from './feishu-media.js';
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
          const durationMs = getVideoDuration(buffer);
          const { fileKey } = await feishuClient.uploadFile(buffer, fileName, fileType, durationMs);

          // Extract first frame as thumbnail for video preview
          let thumbnailImageKey: string | undefined;
          const tmpThumb = path.join(os.tmpdir(), `thumb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`);
          try {
            execSync(
              `ffmpeg -y -i "${filePath}" -vframes 1 -s 320x240 "${tmpThumb}"`,
              { stdio: 'ignore', timeout: 10000 },
            );
            const thumbBuffer = await readFile(tmpThumb);
            if (thumbBuffer.length > 0) {
              const { imageKey } = await feishuClient.uploadImage(thumbBuffer, 'message');
              thumbnailImageKey = imageKey;
            }
          } catch {
            // Thumbnail extraction is optional — video sends fine without it
          } finally {
            await unlink(tmpThumb).catch(() => {});
          }

          const mediaContent: Record<string, unknown> = {
            file_key: fileKey,
            file_name: fileName,
          };
          if (durationMs !== undefined) {
            mediaContent.duration = durationMs;
          }
          if (thumbnailImageKey) {
            mediaContent.image_key = thumbnailImageKey;
          }

          const content = JSON.stringify(mediaContent);
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

// ---------------------------------------------------------------------------
// download_feishu_file — on-demand file download from Feishu messages
// ---------------------------------------------------------------------------

export interface FeishuDownloadToolOptions {
  feishuClient: FeishuClient;
  /** The message ID containing the file attachment. */
  messageId: string;
  /** Allowed download roots (default: data/downloads/). */
  allowedRoots?: string[];
}

/**
 * Create a tool that downloads a file attachment from a Feishu message.
 *
 * This is injected as an extra tool for Feishu sessions so the agent can
 * download file attachments on-demand, rather than having them downloaded
 * immediately when the message is received.
 */
export function createFeishuDownloadTool(options: FeishuDownloadToolOptions) {
  const { feishuClient, messageId } = options;

  const downloadDir = path.resolve(process.cwd(), 'data', 'downloads');

  // Ensure download directory exists
  const ensureDir = async () => {
    try { await mkdir(downloadDir, { recursive: true }); } catch { /* exists */ }
  };
  // Fire and forget — directory will be ready by the time the tool is called
  ensureDir();

  return {
    name: 'download_feishu_file',
    label: 'Download File from Feishu',
    description:
      'Download a file attachment from the current Feishu message. ' +
      'Use this tool when the user has sent a file that you need to read. ' +
      'The file will be saved locally and you can then use file_read to access its content. ' +
      'File attachments include PDFs, documents, spreadsheets, archives, source code files, etc.',
    parameters: Type.Object({
      fileKey: Type.String({
        description: 'The file_key of the attachment to download (mentioned in the system message about the incoming file)',
      }),
    }),
    execute: async (_toolCallId: string, params: { fileKey: string }) => {
      try {
        const downloader = feishuClient as any;
        if (!downloader.downloadResource) {
          return {
            content: [{ type: 'text' as const, text: i18n.t('messages:media.downloadUnavailable') }],
          };
        }

        // Download from Feishu
        const { buffer, fileName: discoveredName, contentType } = await downloader.downloadResource(
          messageId,
          params.fileKey,
          'file',
        );

        // Determine filename
        const ext = (discoveredName && path.extname(discoveredName)) || '';
        const baseName = (discoveredName && path.basename(discoveredName, ext)) || params.fileKey;
        const fileName = sanitizeFileName(baseName + ext);

        // Ensure unique path
        let destPath = path.join(downloadDir, fileName);
        let suffix = 0;
        const originalDest = destPath;
        while (true) {
          try {
            await writeFile(destPath, buffer, { flag: 'wx' }); // wx = write, exclusive
            break;
          } catch (err: any) {
            if (err.code === 'EEXIST') {
              suffix++;
              const nameWithoutExt = baseName;
              destPath = path.join(downloadDir, `${nameWithoutExt}_${suffix}${ext}`);
            } else {
              throw err;
            }
          }
        }

        const sizeStr = buffer.length < 1024
          ? `${buffer.length} B`
          : buffer.length < 1024 * 1024
            ? `${(buffer.length / 1024).toFixed(1)} KB`
            : `${(buffer.length / (1024 * 1024)).toFixed(1)} MB`;

        return {
          content: [{
            type: 'text' as const,
            text:
              `✅ 文件下载成功\n` +
              `- 文件名: ${fileName}\n` +
              `- 大小: ${sizeStr}\n` +
              `- 本地路径: ${destPath}\n` +
              `- 类型: ${contentType || '未知'}\n\n` +
              `你可以使用 file_read 工具读取此文件的内容。`,
          }],
          details: { localPath: destPath, fileName, size: buffer.length },
        };
      } catch (err: any) {
        const message = err.message ?? String(err);
        return {
          content: [{
            type: 'text' as const,
            text: `从飞书下载文件失败: ${message}`,
          }],
        };
      }
    },
  } as AgentTool<any>;
}

function sanitizeFileName(value: string): string {
  return path.basename(value).replace(/[<>:"/\\|?*\x00]/g, '_') || 'download';
}
