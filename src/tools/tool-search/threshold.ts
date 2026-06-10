// ---------------------------------------------------------------------------
// Token estimation and threshold gating for Tool Search
// ---------------------------------------------------------------------------
//
// Decides whether tool search should activate based on the estimated token
// cost of deferrable tool schemas relative to the model's context window.

import type { AgentTool } from '../../pi-mono/agent/types.js';
import type { ToolSearchConfig } from './config.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Rough chars-per-token estimate for English + JSON.
 * 4.0 errs slightly toward underestimating (safer: activates tool search
 * more readily rather than under-activating).
 */
const CHARS_PER_TOKEN = 4.0;

/** Fallback token cutoff when the model's context length is unknown. */
const FALLBACK_TOKEN_CUTOFF = 20_000;

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the token cost of a list of tools from their JSON schemas.
 *
 * Serializes name + description + parameters for each tool and divides
 * total chars by ``CHARS_PER_TOKEN``.  Order-of-magnitude precision is
 * sufficient — the estimate only gates an activate/skip decision.
 */
export function estimateTokens(tools: AgentTool[]): number {
  let totalChars = 0;
  for (const t of tools) {
    try {
      const schema = JSON.stringify({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      });
      totalChars += schema.length;
    } catch {
      // Fall back to a conservative per-tool estimate on serialization failure.
      totalChars += 250;
    }
  }
  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// Activation decision
// ---------------------------------------------------------------------------

/**
 * Decide whether Tool Search should activate for the current assembly.
 *
 * * ``"off"`` → always false.
 * * ``deferrableTokens <= 0`` → always false (no point swapping a no-op).
 * * ``"on"`` → always true.
 * * ``"auto"`` → true when deferrable token cost >= threshold_pct of the
 *   context window.  When ``contextLength`` is unknown (0), falls back to a
 *   fixed 20K token cutoff.
 */
export function shouldActivate(
  config: ToolSearchConfig,
  deferrableTokens: number,
  contextLength: number,
): boolean {
  if (config.enabled === 'off') return false;
  if (deferrableTokens <= 0) return false;
  if (config.enabled === 'on') return true;

  // auto mode
  if (!contextLength || contextLength <= 0) {
    return deferrableTokens >= FALLBACK_TOKEN_CUTOFF;
  }

  const thresholdTokens = Math.floor(contextLength * (config.thresholdPct / 100));
  return deferrableTokens >= thresholdTokens;
}
