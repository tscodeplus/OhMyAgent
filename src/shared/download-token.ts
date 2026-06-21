/**
 * Download token — HMAC-signed tokens for public file download endpoint.
 *
 * Generates short-lived tokens that grant temporary access to specific files
 * without requiring WebUI authentication. Used by the /dl/:token/:filename
 * public endpoint to serve files to external channels (Feishu, Telegram, etc.).
 */

import crypto from 'node:crypto';

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const TOKEN_VERSION = 1;

function getSecret(): string {
  // Use a stable server-side secret. In production, this should be a fixed
  // value derived from config or an env var. For now, derive from the app
  // secret (Feishu) if available, otherwise fall back to a random per-process key.
  const envSecret = process.env.OHMYAGENT_DOWNLOAD_SECRET
    || process.env.FEISHU_APP_SECRET
    || crypto.randomBytes(32).toString('hex');
  return envSecret;
}

let _secret: string | null = null;
function secret(): string {
  if (!_secret) _secret = getSecret();
  return _secret;
}

/**
 * Generate a download token for the given file path.
 *
 * The token encodes the file path, expiry timestamp, and an HMAC signature
 * to prevent tampering. The filename is NOT embedded in the token — it is
 * passed separately in the URL path for readability.
 *
 * @param filePath  Absolute path to the file to serve.
 * @param ttlMs     Token validity period in milliseconds (default: 1 hour).
 * @returns         URL-safe base64 token string.
 */
export function generateDownloadToken(filePath: string, ttlMs: number = DEFAULT_TTL_MS): string {
  const expiry = Date.now() + ttlMs;

  const payload = JSON.stringify({
    v: TOKEN_VERSION,
    p: filePath,
    e: expiry,
  });

  const payloadB64 = Buffer.from(payload, 'utf-8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', secret())
    .update(payloadB64)
    .digest('base64url');

  return `${payloadB64}.${sig}`;
}

interface TokenPayload {
  filePath: string;
  expiry: number;
}

/**
 * Verify and decode a download token.
 *
 * @param token  The token string from the URL.
 * @returns      The decoded file path and expiry, or null if invalid/expired/tampered.
 */
export function verifyDownloadToken(token: string): TokenPayload | null {
  const dotIndex = token.lastIndexOf('.');
  if (dotIndex < 0) return null;

  const payloadB64 = token.slice(0, dotIndex);
  const sig = token.slice(dotIndex + 1);

  // Verify HMAC signature
  const expectedSig = crypto
    .createHmac('sha256', secret())
    .update(payloadB64)
    .digest('base64url');

  if (sig.length !== expectedSig.length) return null;
  // Constant-time comparison
  let mismatch = 0;
  for (let i = 0; i < sig.length; i++) {
    mismatch |= sig.charCodeAt(i) ^ expectedSig.charCodeAt(i);
  }
  if (mismatch !== 0) return null;

  // Decode payload
  let payload: { v: number; p: string; e: number };
  try {
    const json = Buffer.from(payloadB64, 'base64url').toString('utf-8');
    payload = JSON.parse(json);
  } catch {
    return null;
  }

  if (payload.v !== TOKEN_VERSION) return null;
  if (typeof payload.p !== 'string' || typeof payload.e !== 'number') return null;

  // Check expiry
  if (Date.now() > payload.e) return null;

  return { filePath: payload.p, expiry: payload.e };
}

/**
 * Create a public download URL for the given file path.
 *
 * @param filePath  Absolute path to the file.
 * @param fileName  Display filename for the URL path.
 * @param baseUrl   Server base URL (e.g., "http://localhost:9191").
 * @param ttlMs     Token TTL in ms (default: 1 hour).
 * @returns         Full download URL like "/dl/<token>/<filename>".
 */
export function createDownloadUrl(
  filePath: string,
  fileName: string,
  baseUrl?: string,
  ttlMs?: number,
): string {
  const token = generateDownloadToken(filePath, ttlMs);
  const encodedName = encodeURIComponent(fileName);
  const path = `/dl/${token}/${encodedName}`;
  if (baseUrl) return `${baseUrl}${path}`;
  return path;
}
