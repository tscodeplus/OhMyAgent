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

/**
 * Extract video duration in milliseconds from an MP4/MOV buffer.
 *
 * Parses the ISO Base Media File Format (ISOBMFF) atom tree to find the
 * `mvhd` (movie header) atom inside the `moov` atom and reads the
 * timescale + duration fields.
 *
 * Returns duration in milliseconds, or undefined if the format is not
 * recognized or the buffer does not contain a valid moov atom.
 */
export function getVideoDuration(buffer: Buffer): number | undefined {
  try {
    // Find and parse the moov atom
    const moov = findAtom(buffer, 'moov', 0, buffer.length);
    if (!moov) return undefined;

    // Find mvhd inside moov
    const mvhd = findAtom(buffer, 'mvhd', moov.offset + 8, moov.offset + moov.size);
    if (!mvhd) return undefined;

    // mvhd is at least 24 bytes after the atom header (version + flags + timescale + duration)
    const dataStart = mvhd.offset + 8;
    if (dataStart + 16 > mvhd.offset + mvhd.size) return undefined;

    const version = buffer[dataStart];
    if (version > 1) return undefined; // unknown mvhd version

    if (version === 0) {
      // 32-bit fields
      const timescale = buffer.readUInt32BE(dataStart + 12);
      const duration = buffer.readUInt32BE(dataStart + 16);
      if (timescale === 0) return undefined;
      return Math.round((duration / timescale) * 1000);
    }

    // version === 1: 64-bit duration
    const timescale = buffer.readUInt32BE(dataStart + 20);
    const duration = Number(buffer.readBigUInt64BE(dataStart + 24));
    if (timescale === 0) return undefined;
    return Math.round((duration / timescale) * 1000);
  } catch {
    return undefined;
  }
}

/**
 * Find an ISOBMFF atom by its 4-CC type within a byte range in the buffer.
 */
function findAtom(
  buffer: Buffer,
  type: string,
  rangeStart: number,
  rangeEnd: number,
): { offset: number; size: number } | undefined {
  let pos = rangeStart;
  while (pos + 8 <= rangeEnd) {
    let size = buffer.readUInt32BE(pos);
    const atomType = buffer.toString('ascii', pos + 4, pos + 8);

    if (size === 0) {
      // Atom extends to end of file
      size = rangeEnd - pos;
    } else if (size === 1) {
      // 64-bit extended size
      if (pos + 16 > rangeEnd) return undefined;
      size = Number(buffer.readBigUInt64BE(pos + 8));
    }

    if (size < 8 || pos + size > rangeEnd) return undefined;

    if (atomType === type) {
      return { offset: pos, size };
    }

    pos += size;
  }
  return undefined;
}
