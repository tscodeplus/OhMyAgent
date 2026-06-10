// ---------------------------------------------------------------------------
// Tool Search configuration
// ---------------------------------------------------------------------------

import type { AppConfig } from '../../app/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolSearchConfig {
  /** Enable mode. */
  enabled: 'auto' | 'on' | 'off';
  /** Percentage of context length at which auto mode activates (0-100). */
  thresholdPct: number;
  /** Default number of results returned by tool_search. */
  searchDefaultLimit: number;
  /** Hard upper bound on results the model can request. */
  maxSearchLimit: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: ToolSearchConfig = {
  enabled: 'on',
  thresholdPct: 10,
  searchDefaultLimit: 5,
  maxSearchLimit: 20,
};

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load tool-search configuration from the app config.
 *
 * Applies validation and clamping; any invalid field falls back to its
 * default value rather than throwing.
 *
 * @param appConfig Optional config object. When omitted, returns defaults
 *   (suitable for tests).
 */
export function loadConfig(appConfig?: AppConfig): ToolSearchConfig {
  const raw = appConfig?.toolSearch;

  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULTS };
  }

  // enabled
  let enabled: ToolSearchConfig['enabled'] = DEFAULTS.enabled;
  const rawEnabled = String(
    (raw as Record<string, unknown>).enabled ?? DEFAULTS.enabled,
  ).trim().toLowerCase();
  if (rawEnabled === 'auto' || rawEnabled === 'on' || rawEnabled === 'off') {
    enabled = rawEnabled;
  }

  // thresholdPct
  let thresholdPct = safeFloat(
    (raw as Record<string, unknown>).thresholdPct,
    DEFAULTS.thresholdPct,
  );
  thresholdPct = Math.max(0, Math.min(100, thresholdPct));

  // maxSearchLimit
  let maxSearchLimit = safeInt(
    (raw as Record<string, unknown>).maxSearchLimit,
    DEFAULTS.maxSearchLimit,
  );
  maxSearchLimit = Math.max(1, Math.min(50, maxSearchLimit));

  // searchDefaultLimit
  let searchDefaultLimit = safeInt(
    (raw as Record<string, unknown>).searchDefaultLimit,
    DEFAULTS.searchDefaultLimit,
  );
  searchDefaultLimit = Math.max(1, Math.min(maxSearchLimit, searchDefaultLimit));

  return {
    enabled,
    thresholdPct,
    searchDefaultLimit,
    maxSearchLimit,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeFloat(value: unknown, fallback: number): number {
  if (typeof value === 'number' && !Number.isNaN(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}

function safeInt(value: unknown, fallback: number): number {
  const f = safeFloat(value, fallback);
  return Math.round(f);
}
