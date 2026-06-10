/**
 * iLink media upload / download with AES-128-ECB encryption.
 *
 * Media files (images, files, videos) are encrypted client-side before
 * being uploaded to the WeChat CDN. The encryption key and a download
 * parameter are included in the message so the recipient can decrypt.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import { aesEncrypt, aesDecrypt, paddedSize } from './wechat-crypto.js';
import { apiPost } from './wechat-api.js';
import type { ILUploadUrlResponse, ILMediaParam } from './wechat-types.js';

const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';

/** CDN hostname for inbound media download. */
export const ILINK_CDN_HOST = 'novac2c.cdn.weixin.qq.com';

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Upload a media file to the iLink CDN and return the encrypted media param
 * used in sendmessage item_list.
 *
 * Flow:
 * 1. Read file, compute md5 and padded size.
 * 2. Generate ephemeral AES key and filekey.
 * 3. Request a signed CDN upload URL via getuploadurl.
 * 4. Encrypt the file buffer with AES-128-ECB.
 * 5. POST encrypted bytes to the CDN.
 * 6. Extract x-encrypted-param from the CDN response header.
 * 7. Return the media param with encrypt_query_param and aes_key.
 *
 * @param apiBase     iLink API base URL.
 * @param botToken    Bot authentication token.
 * @param filePath    Local path to the file to upload.
 * @param mediaType   UploadMediaType constant (1=image, 2=video, 3=file).
 * @param toUserId    Recipient's from_user_id.
 * @param aesKey      Optional base64 AES key from config; if absent a random
 *                    key is generated per upload.
 * @param logger      Logger instance.
 * @returns           ILMediaParam with encrypt_query_param and aes_key,
 *                    suitable for inclusion in a sendmessage item_list.
 */
export async function uploadMedia(
  apiBase: string,
  botToken: string,
  filePath: string,
  mediaType: number,
  toUserId: string,
  aesKey: string | undefined,
  logger: Logger,
): Promise<ILMediaParam> {
  // 1. Read file
  const rawBuffer = await fs.readFile(filePath);
  const rawSize = rawBuffer.length;
  const rawFileMd5 = crypto.createHash('md5').update(rawBuffer).digest('hex');
  const fileSize = paddedSize(rawSize);

  // 2. Generate ephemeral keys
  const filekey = crypto.randomBytes(16).toString('hex');
  const ephemeralAesKey = crypto.randomBytes(16);
  const ephemeralAesKeyHex = ephemeralAesKey.toString('hex');
  const ephemeralAesKeyBase64 = ephemeralAesKey.toString('base64');

  // Use configured aesKey if provided (for deterministic key testing)
  const effectiveAesKeyBase64 = aesKey ?? ephemeralAesKeyBase64;
  const effectiveAesKeyHex = aesKey
    ? Buffer.from(aesKey, 'base64').toString('hex')
    : ephemeralAesKeyHex;

  // 3. Request signed upload URL
  logger.debug({ filePath, rawSize, fileSize }, 'Requesting iLink upload URL');

  const uploadResp: ILUploadUrlResponse = await apiPost(
    apiBase,
    botToken,
    'ilink/bot/getuploadurl',
    {
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize: rawSize,
      rawfilemd5: rawFileMd5,
      filesize: fileSize,
      no_need_thumb: true,
      aeskey: effectiveAesKeyHex,
    },
    30_000,
  );

  if (!uploadResp.upload_param) {
    throw new Error('iLink upload did not return upload_param');
  }

  // 4. Encrypt file buffer
  const encrypted = aesEncrypt(rawBuffer, effectiveAesKeyBase64);

  // 5. Upload encrypted data to CDN
  const cdnUrl = buildCdnUploadUrl(uploadResp.upload_param, filekey);
  logger.debug({ cdnUrl }, 'Uploading encrypted media to CDN');

  const cdnRes = await fetch(cdnUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: encrypted as BodyInit,
  });

  if (!cdnRes.ok) {
    const errorText = await cdnRes.text().catch(() => '');
    throw new Error(
      `CDN upload failed: HTTP ${cdnRes.status} ${cdnRes.statusText} ${errorText}`,
    );
  }

  // 6. Extract download parameter from response header
  const downloadParam = cdnRes.headers.get('x-encrypted-param');
  if (!downloadParam) {
    throw new Error('CDN upload response missing x-encrypted-param header');
  }

  // 7. Return media param
  // aes_key: base64 of the hex-encoded key string (matches @tencent-weixin/openclaw-weixin)
  return {
    encrypt_query_param: downloadParam,
    aes_key: Buffer.from(effectiveAesKeyHex).toString('base64'),
    encrypt_type: 1,
    fileSizeCiphertext: fileSize,
  };
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/**
 * Download and decrypt a media file from the iLink CDN.
 *
 * @param mediaParam  The ILMediaParam from an inbound message
 *                    (image_item.media, file_item.media, etc.).
 * @returns           Decrypted raw file buffer.
 */
export async function downloadMedia(mediaParam: ILMediaParam): Promise<Buffer> {
  const cdnUrl = buildCdnDownloadUrl(mediaParam.encrypt_query_param);

  const res = await fetch(cdnUrl);
  if (!res.ok) {
    throw new Error(
      `CDN download failed: HTTP ${res.status} ${res.statusText}`,
    );
  }

  const encrypted = Buffer.from(await res.arrayBuffer());

  // If no aes_key is provided, return the encrypted buffer as-is
  if (!mediaParam.aes_key) {
    return encrypted;
  }

  return aesDecrypt(encrypted, mediaParam.aes_key);
}

// ---------------------------------------------------------------------------
// CDN URL builders
// ---------------------------------------------------------------------------

function buildCdnUploadUrl(uploadParam: string, filekey: string): string {
  // Parameter name is encrypted_query_param (matches @tencent-weixin/openclaw-weixin)
  return `${CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

function buildCdnDownloadUrl(encryptedQueryParam: string): string {
  const url = new URL(`${CDN_BASE}/download`);
  url.searchParams.set('encrypted_query_param', encryptedQueryParam);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Inbound media download (from received messages)
// ---------------------------------------------------------------------------

/**
 * Download and decrypt an inbound media file from the iLink CDN, then write
 * it to disk.
 *
 * The `mediaItem` should be an iLink message item (object with a `type`
 * field and nested media params). The function navigates the item to find
 * the `encrypt_query_param` and determines the media type automatically.
 *
 * @param mediaItem   ILMessage item (or raw object with encrypt_query_param).
 * @param cdnBaseUrl  CDN hostname (e.g. "novac2c.cdn.weixin.qq.com").
 * @param aesKey      Base64 AES-128 key for decryption.
 * @param savePath    Absolute file path to write the decrypted content.
 * @param logger      Logger instance.
 * @returns           Object with filePath and resolved mediaType.
 */
export async function downloadInboundMedia(
  mediaItem: unknown,
  cdnBaseUrl: string,
  aesKey: string,
  savePath: string,
  logger: Logger,
): Promise<{ filePath: string; mediaType: string }> {
  const queryParam = resolveQueryParam(mediaItem);
  if (!queryParam) {
    throw new Error('Missing encrypt_query_param in media item');
  }

  const cdnUrl = `https://${cdnBaseUrl}/c2c/download?${queryParam}`;
  logger.debug({ cdnUrl }, 'Downloading inbound media from CDN');

  const res = await fetch(cdnUrl);
  if (!res.ok) {
    throw new Error(
      `CDN download failed: HTTP ${res.status} ${res.statusText}`,
    );
  }

  const encrypted = Buffer.from(await res.arrayBuffer());
  const decrypted = aesDecrypt(encrypted, aesKey);

  // Ensure parent directory exists and write file
  await fs.mkdir(path.dirname(savePath), { recursive: true });
  await fs.writeFile(savePath, decrypted);

  const mediaType = resolveMediaType(mediaItem);
  return { filePath: savePath, mediaType };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract `encrypt_query_param` from a media item.
 *
 * Handles both direct ILMediaParam objects and full iLink message items
 * (type 2-5) with nested media params.
 */
function resolveQueryParam(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;

  // Direct ILMediaParam
  if (typeof obj.encrypt_query_param === 'string') return obj.encrypt_query_param;

  // Navigate by item type
  const type = obj.type;
  if (type === 2) return (obj.image_item as any)?.media?.encrypt_query_param ?? null;
  if (type === 3) return (obj.voice_item as any)?.media?.encrypt_query_param ?? null;
  if (type === 4) return (obj.file_item as any)?.media?.encrypt_query_param ?? null;
  if (type === 5) return (obj.video_item as any)?.media?.encrypt_query_param ?? null;
  return null;
}

/**
 * Determine the media type string from an iLink message item.
 */
function resolveMediaType(item: unknown): string {
  if (!item || typeof item !== 'object') return 'file';
  const type = (item as Record<string, unknown>).type;
  if (type === 2) return 'image';
  if (type === 3) return 'voice';
  if (type === 4) return 'file';
  if (type === 5) return 'video';
  return 'file';
}
