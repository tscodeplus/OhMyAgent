// src/computer-use/model-policy.ts

import type { Ctx } from './types.js';

/**
 * Check whether the current model can see screenshots.
 * Computer Use returns element trees alongside screenshots, so non-vision
 * models can still control the desktop — they just won't "see" the image.
 *
 * @returns true if the model supports image input (screenshots visible)
 */
export function isComputerUseModelSupported(ctx: Ctx): boolean {
  if (!ctx.model) return false;
  return ctx.model.input.includes('image');
}
