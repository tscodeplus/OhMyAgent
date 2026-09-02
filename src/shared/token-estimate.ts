/**
 * The one token estimator the gateway shares.
 *
 * `chars / 4` — the usual English heuristic — is roughly right for ASCII and
 * wrong by ~2x for Chinese/Japanese/Korean, where a single character is
 * typically one or two tokens. Underestimating is the dangerous direction here:
 * the estimate drives when conversation compression triggers, so a zh-CN
 * transcript looked half-empty and overflowed the provider's context window
 * before compression ever kicked in.
 *
 * Non-ASCII is charged at 1 token per 2 characters, which overestimates for
 * Cyrillic/Greek and underestimates for rare CJK — acceptable for a soft budget
 * and far closer than a single flat ratio for a zh-CN-first product.
 */

const ASCII_TOKENS_PER_CHAR = 0.25;
const NON_ASCII_TOKENS_PER_CHAR = 0.5;

/** Estimated tokens for a string, weighting non-ASCII characters higher. */
export function estimateTokensForText(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    tokens += ch.charCodeAt(0) > 127 ? NON_ASCII_TOKENS_PER_CHAR : ASCII_TOKENS_PER_CHAR;
  }
  return tokens;
}

/**
 * Rough cost of one image block, matching pi-mono's own budget: it charges
 * ESTIMATED_IMAGE_CHARS = 4800 characters per image at 4 chars/token. Keeping
 * the same figure stops screenshot-heavy turns from being sized differently
 * here than by the vendor estimator that guards the context window.
 */
export const IMAGE_BLOCK_TOKENS = 1200;
