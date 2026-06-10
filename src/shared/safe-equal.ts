import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison.
 *
 * Plain `a === b` short-circuits on the first differing byte, leaking the
 * length of the matching prefix through timing. Use this for any comparison of
 * secrets, tokens, or signatures against attacker-supplied input.
 *
 * Returns false (without throwing) for non-string / length-mismatched inputs.
 * Length is intentionally compared in non-constant time: token/signature length
 * is not itself a secret, and `timingSafeEqual` requires equal-length buffers.
 */
export function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
