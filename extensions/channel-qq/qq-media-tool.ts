/**
 * QQ media send tool — allows the agent to send images/files to a QQ chat.
 *
 * Uploads via JSON (file_data base64, NOT multipart), then sends as
 * msg_type=7 with media.file_info.
 */

import { readFile } from 'fs/promises';
import path from 'path';
import os from 'os';
import { isWithinRoot } from '../../src/shared/path-utils.js';
import { Type } from 'typebox';
import type { AgentTool } from '../../src/pi-mono/agent/types.js';
import type { QQGateway } from './qq-gateway.js';

export interface QqMediaToolOptions {
  gateway: QQGateway;
  openid?: string;
  groupOpenid?: string;
  allowedRoots?: string[];
  logger?: { error: (...args: any[]) => void };
  deniedPatterns?: string[];
}

function matchGlob(filePath: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(filePath);
}

export function createQqMediaTool(options: QqMediaToolOptions): AgentTool<any> {
  const { gateway, openid, groupOpenid } = options;

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

  const target: { openid?: string; groupOpenid?: string } = {};
  if (groupOpenid) target.groupOpenid = groupOpenid;
  else if (openid) target.openid = openid;
  else throw new Error('QQ media tool requires openid or groupOpenid');

  return {
    name: 'qq_send_media',
    label: 'Send local file or image to the user via QQ',
    description:
      'Send a local file or image to the QQ user. Provide the absolute path of the file on disk.',
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
        const videoExts = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.3gp', '.m4v'];
        const fileType = imageExts.includes(ext) ? 1
          : videoExts.includes(ext) ? 2
          : 4;

        await sendQQMediaBuffer(gateway, buffer, fileName, fileType, target, options.logger);

        return { content: [{ type: 'text' as const, text: `File sent: ${fileName}` }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed to send media: ${err.message}` }] };
      }
    },
  } as AgentTool<any>;
}

export async function sendQQMediaBuffer(
  gateway: QQGateway,
  buffer: Buffer,
  filename: string,
  fileType: 1 | 2 | 3 | 4,
  target: { openid?: string; groupOpenid?: string },
  logger?: { error: (...args: any[]) => void },
): Promise<void> {
  const uploadResult = await uploadQQFileJson(gateway, buffer, filename, fileType, target, logger);
  if (!uploadResult) {
    throw new Error('Failed to upload file to QQ');
  }

  const msgPath = target.groupOpenid
    ? `/v2/groups/${target.groupOpenid}/messages`
    : `/v2/users/${target.openid}/messages`;
  const sendBody: Record<string, unknown> = {
    msg_type: 7,
    media: { file_info: uploadResult.file_info },
    msg_seq: Date.now() % (1 << 31),
  };
  await gateway.sendRestApi('POST', msgPath, sendBody);
}

/**
 * Upload a file to QQ Bot API v2 using JSON format (matches OpenClaw).
 *
 * POST /v2/users/{openid}/files (or /v2/groups/{id}/files)
 * Body: { file_type: 1|2|3|4, file_data: "<base64>", srv_send_msg: false }
 * Response: { file_uuid, file_info, ttl }
 */
async function uploadQQFileJson(
  gateway: QQGateway,
  buffer: Buffer,
  filename: string,
  fileType: number,
  target: { openid?: string; groupOpenid?: string },
  log?: { error: (...args: any[]) => void },
): Promise<{ file_uuid: string; file_info: string; ttl: number } | null> {
  try {
    const token = await (gateway as any).auth.getAccessToken() as string;
    const baseUrl = (gateway as any).auth.getApiBase() as string;

    const uploadPath = target.groupOpenid
      ? `/v2/groups/${target.groupOpenid}/files`
      : `/v2/users/${target.openid}/files`;

    const body: Record<string, unknown> = {
      file_type: fileType,
      file_data: buffer.toString('base64'),
      srv_send_msg: false,
    };

    // For files and videos (not images), include file_name
    if (fileType === 4 || fileType === 2) {
      body.file_name = filename;
    }

    const url = `${baseUrl}${uploadPath}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `QQBot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      log?.error('QQ file upload failed:', text);
      return null;
    }

    const result = await response.json() as any;
    if (!result.file_info) {
      log?.error('QQ file upload: no file_info in response:', JSON.stringify(result));
      return null;
    }
    return {
      file_uuid: result.file_uuid ?? '',
      file_info: result.file_info,
      ttl: result.ttl ?? 0,
    };
  } catch (err) {
    log?.error('QQ file upload error:', err);
    return null;
  }
}
