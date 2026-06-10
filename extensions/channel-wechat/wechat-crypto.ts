/**
 * AES-128-ECB encryption/decryption for iLink media transfer.
 *
 * The iLink protocol uses AES-128-ECB with PKCS7 padding for media
 * encryption. The key can be provided as base64 of 16 raw bytes, or
 * base64 of a 32-character hex string.
 */

import crypto from 'node:crypto';

/**
 * Decode an iLink AES key from its base64 representation.
 *
 * Two formats are accepted:
 * 1. Base64 of 16 raw bytes (common for media params in messages)
 * 2. Base64 of a 32-character hex string (used during upload)
 */
function parseAesKey(keyBase64: string): Buffer {
  const decoded = Buffer.from(keyBase64, 'base64');
  if (decoded.length === 16) {
    return decoded;
  }
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error(
    `Invalid aes_key length: ${decoded.length}. Expected 16 raw bytes or 32 hex chars after base64 decode.`,
  );
}

/**
 * Encrypt data with AES-128-ECB (PKCS7 padding).
 *
 * @param data       Raw plaintext buffer.
 * @param keyBase64  Base64-encoded AES key (16 raw bytes or 32 hex chars).
 * @returns          Encrypted buffer padded to a multiple of 16 bytes.
 */
export function aesEncrypt(data: Buffer, keyBase64: string): Buffer {
  const key = parseAesKey(keyBase64);
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

/**
 * Decrypt data with AES-128-ECB (PKCS7 padding).
 *
 * @param data       Encrypted ciphertext buffer.
 * @param keyBase64  Base64-encoded AES key (16 raw bytes or 32 hex chars).
 * @returns          Decrypted plaintext buffer.
 */
export function aesDecrypt(data: Buffer, keyBase64: string): Buffer {
  const key = parseAesKey(keyBase64);
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/**
 * Compute PKCS7-padded size for a given raw size.
 * AES-ECB always adds 1-16 bytes of padding.
 */
export function paddedSize(rawSize: number): number {
  return Math.ceil((rawSize + 1) / 16) * 16;
}
