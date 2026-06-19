/**
 * Media utility functions for Feishu image/file handling.
 *
 * Provides MIME type detection, Buffer-to-ImageContent conversion,
 * and file extension helpers.
 */

import type { ImageContent } from '../../src/pi-mono/ai/types.js';

/**
 * Detect MIME type from a buffer's magic bytes.
 * Covers common image, audio, video, and document formats.
 */
export function detectMimeType(buffer: Buffer): string {
  if (buffer.length < 4) return 'application/octet-stream';

  const head = buffer;

  // Image formats
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png';
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) return 'image/gif';
  if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46) return 'image/webp';
  if (head[0] === 0x42 && head[1] === 0x4d) return 'image/bmp';

  // Audio/Video formats
  if (head[0] === 0x4f && head[1] === 0x67 && head[2] === 0x67 && head[3] === 0x53) return 'audio/ogg';
  if (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) return 'video/mp4';

  // Document formats
  if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return 'application/pdf';

  return 'application/octet-stream';
}

/**
 * Convert a Buffer to pi-mono ImageContent (base64 encoded).
 */
export function imageBufferToImageContent(buffer: Buffer): ImageContent {
  const mimeType = detectMimeType(buffer);
  const data = buffer.toString('base64');
  return { type: 'image', data, mimeType };
}

/**
 * Check whether a file name has a known image extension.
 */
export function isImageExtension(fileName: string): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (!ext) return false;
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'ico', 'tiff', 'tif', 'heic', 'heif'].includes(ext);
}

/**
 * Check whether a file name has a known video extension.
 */
export function isVideoExtension(fileName: string): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (!ext) return false;
  return ['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'wmv', '3gp', 'm4v'].includes(ext);
}

/**
 * Map a file extension to a Feishu file type for upload.
 */
export function detectFileType(fileName: string): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'opus':
    case 'ogg':
      return 'opus';
    case 'mp4':
    case 'mov':
    case 'avi':
    case 'mkv':
    case 'webm':
      return 'mp4';
    case 'pdf':
      return 'pdf';
    case 'doc':
    case 'docx':
      return 'doc';
    case 'xls':
    case 'xlsx':
    case 'csv':
      return 'xls';
    case 'ppt':
    case 'pptx':
      return 'ppt';
    default:
      return 'stream';
  }
}
