/**
 * Feishu request signature verification and event decryption.
 *
 * Supports two verification methods:
 * 1. Token-based: the `token` field in the event body is compared with the configured verification token.
 * 2. Signature-based: SHA-256(timestamp + nonce + encrypt_key + body) is compared with the `signature` header.
 */

import { createHash, createDecipheriv } from 'node:crypto';
import { safeEqual } from '../../src/shared/safe-equal.js';

export interface FeishuAuthConfig {
  verificationToken?: string;
  encryptKey?: string;
}

/**
 * Max allowed clock skew between the Feishu request timestamp and local time.
 * Requests outside this window are rejected to limit replay attacks.
 */
export const SIGNATURE_FRESHNESS_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Constant-time token comparison.
 *
 * @param token - The token from the incoming request.
 * @param expectedToken - The expected verification token.
 * @returns true if the tokens match.
 */
export function verifyToken(token: string, expectedToken: string): boolean {
  return safeEqual(token, expectedToken);
}

/**
 * Compute and verify the SHA-256 signature for a Feishu request.
 *
 * Signature = SHA-256(timestamp + nonce + encryptKey + body)
 *
 * @param body - The raw request body (or encrypted body string).
 * @param timestamp - Timestamp from the request headers.
 * @param nonce - Nonce from the request headers.
 * @param signature - The signature from the request headers.
 * @param encryptKey - The configured encrypt key.
 * @returns true if the computed signature matches the provided signature.
 */
export function verifySignature(
  body: string,
  timestamp: string,
  nonce: string,
  signature: string,
  encryptKey: string,
): boolean {
  const content = timestamp + nonce + encryptKey + body;
  const expected = createHash('sha256').update(content).digest('hex');
  return safeEqual(expected, signature);
}

/**
 * Check that a Feishu request timestamp is within the freshness window.
 *
 * Feishu sends a Unix timestamp in *seconds*. Stale or far-future timestamps
 * are rejected to reduce the replay window for captured requests.
 *
 * @param timestamp - The timestamp string from the request (seconds).
 * @param windowMs - Allowed skew in milliseconds (default 5 min).
 * @returns true if the timestamp is within the window.
 */
export function isTimestampFresh(
  timestamp: string,
  windowMs: number = SIGNATURE_FRESHNESS_WINDOW_MS,
): boolean {
  const tsSec = Number(timestamp);
  if (!Number.isFinite(tsSec) || tsSec <= 0) return false;
  const tsMs = tsSec * 1000;
  return Math.abs(Date.now() - tsMs) <= windowMs;
}

/**
 * Decrypt an AES-encrypted event body.
 *
 * Feishu encryption:
 * - key = SHA-256(encryptKey), producing 32 bytes
 * - iv  = first 16 bytes of the base64-decoded encrypted data
 * - plaintext = AES-256-CBC decrypt (remaining bytes after IV)
 *
 * @param encrypt - Base64-encoded encrypted event JSON.
 * @param encryptKey - The configured encrypt key.
 * @returns The decrypted JSON string.
 */
export function decryptEvent(encrypt: string, encryptKey: string): string {
  const key = createHash('sha256').update(encryptKey).digest();
  const encrypted = Buffer.from(encrypt, 'base64');
  const iv = encrypted.subarray(0, 16);
  const data = encrypted.subarray(16);

  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf-8');
}

/**
 * Verify a token from a Feishu event body against the configured verification token.
 *
 * @param body - The event body containing a token field.
 * @param config - Auth configuration.
 * @returns true if the request passes verification.
 */
export function verifyEventToken(
  body: { token?: string },
  config: FeishuAuthConfig,
): boolean {
  // Fail-closed: if no verification token is configured we cannot assert the
  // request came from Feishu via the token path. Callers must rely on
  // signature verification (encryptKey) instead — see authenticateEvent.
  if (!config.verificationToken) return false;
  if (!body.token) return false;
  return verifyToken(body.token, config.verificationToken);
}

/**
 * Verify the signature of a Feishu event request.
 *
 * @param body - The raw request body string.
 * @param timestamp - Timestamp from the request.
 * @param nonce - Nonce from the request.
 * @param signature - The signature from the request.
 * @param config - Auth configuration.
 * @returns true if the signature is valid.
 */
export function verifyEventSignature(
  body: string,
  timestamp: string,
  nonce: string,
  signature: string,
  config: FeishuAuthConfig,
): boolean {
  if (!config.encryptKey) return false;
  return verifySignature(body, timestamp, nonce, signature, config.encryptKey);
}

export interface EventAuthInput {
  /** Raw (pre-parse) request body string — required for signature checks. */
  rawBody?: string;
  signature?: string;
  timestamp?: string;
  nonce?: string;
  /** Parsed/decrypted body, used for the token-verification path. */
  parsedBody?: { token?: string };
}

export type EventAuthReason =
  | 'no-credentials'
  | 'stale-timestamp'
  | 'bad-signature'
  | 'missing-signature'
  | 'bad-token';

export interface EventAuthResult {
  ok: boolean;
  reason?: EventAuthReason;
}

/**
 * Fail-closed authentication for an inbound Feishu event.
 *
 * Security model:
 *   - At least one credential (encryptKey or verificationToken) MUST be
 *     configured, otherwise every request is rejected ('no-credentials').
 *     This closes the prior default-allow hole where an unconfigured gateway
 *     accepted arbitrary webhook traffic.
 *   - When encryptKey is configured, signature verification is REQUIRED and
 *     includes a timestamp freshness check to bound replay. Missing signature
 *     headers are rejected rather than silently skipped.
 *   - When only verificationToken is configured (Feishu token-only mode), the
 *     body token is compared in constant time. This mode has no signature and
 *     is inherently replayable — prefer enabling encryption.
 */
export function authenticateEvent(
  input: EventAuthInput,
  config: FeishuAuthConfig,
): EventAuthResult {
  const hasSignatureCreds = !!config.encryptKey;
  const hasTokenCreds = !!config.verificationToken;

  if (!hasSignatureCreds && !hasTokenCreds) {
    return { ok: false, reason: 'no-credentials' };
  }

  if (hasSignatureCreds) {
    const { rawBody, signature, timestamp, nonce } = input;
    if (!signature || !timestamp || !nonce || rawBody === undefined) {
      return { ok: false, reason: 'missing-signature' };
    }
    if (!isTimestampFresh(timestamp)) {
      return { ok: false, reason: 'stale-timestamp' };
    }
    if (!verifyEventSignature(rawBody, timestamp, nonce, signature, config)) {
      return { ok: false, reason: 'bad-signature' };
    }
    return { ok: true };
  }

  // Token-only mode.
  if (!verifyEventToken(input.parsedBody ?? {}, config)) {
    return { ok: false, reason: 'bad-token' };
  }
  return { ok: true };
}

/**
 * Process a raw Feishu event body, handling encryption and returning the plaintext event JSON.
 *
 * @param body - Parsed event body object.
 * @param config - Auth configuration.
 * @returns Parsed event body (decrypted if necessary).
 * @throws If decryption fails.
 */
export function processEventBody(
  body: { encrypt?: string; event?: Record<string, unknown> },
  config: FeishuAuthConfig,
): Record<string, unknown> {
  if (body.encrypt && config.encryptKey) {
    const decrypted = decryptEvent(body.encrypt, config.encryptKey);
    return JSON.parse(decrypted) as Record<string, unknown>;
  }
  return body.event ?? body;
}
