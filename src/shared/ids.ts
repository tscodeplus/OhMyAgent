import { randomBytes } from 'crypto';

/**
 * Generate a unique ID (nanoid-compatible, 21 chars).
 */
export function generateId(): string {
  return randomBytes(16)
    .toString('base64url')
    .slice(0, 21);
}

/**
 * Generate a short ID (8 chars).
 */
export function shortId(): string {
  return randomBytes(6)
    .toString('base64url')
    .slice(0, 8);
}
