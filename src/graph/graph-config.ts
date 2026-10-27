/**
 * Configuration for the knowledge-graph projector (`memory.graph`).
 *
 * The projector only re-reads `memory_links` — it never calls a model — but it
 * does write to `entities`/`entity_edges`, so it gets its own switch instead of
 * riding on `memory.maintenance.enabled`: an operator may want the maintenance
 * scheduler without the graph (or the other way round), and the CLI
 * (`pnpm graph:sync`) must be able to reuse the same defaults.
 *
 * `src/app/config.ts` validates the same block with zod at startup, so a bad
 * value in config.yaml already fails there. This resolver exists for the paths
 * that bypass `loadConfig` (tests, hand-built `AppConfig` objects, the CLI)
 * and it validates strictly rather than silently falling back: a
 * `max_links_per_run: "lots"` typo must not turn into a default that hides it.
 */

export interface GraphSyncConfig {
  /** Master switch: when false the projector is never registered or run. */
  enabled: boolean;
  /** Drop `memory_links` rows below this confidence. */
  minConfidence: number;
  /** Upper bound on links projected per run (keeps one run cheap). */
  maxLinksPerRun: number;
}

export const DEFAULT_GRAPH_SYNC_CONFIG: GraphSyncConfig = {
  enabled: true,
  minConfidence: 0.3,
  maxLinksPerRun: 500,
};

/** Raw `memory.graph` block; every field is `unknown` because YAML is untyped. */
export interface RawGraphSyncConfig {
  enabled?: unknown;
  min_confidence?: unknown;
  max_links_per_run?: unknown;
}

function readBoolean(value: unknown, key: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new TypeError(`memory.graph.${key} must be a boolean, got ${typeof value}`);
  }
  return value;
}

function readFraction(value: unknown, key: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`memory.graph.${key} must be a number between 0 and 1`);
  }
  return value;
}

function readCount(value: unknown, key: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`memory.graph.${key} must be a positive integer`);
  }
  return value;
}

/**
 * Resolve the `memory.graph` block into a complete config, applying defaults
 * for absent keys and rejecting values that could not be honoured.
 */
export function resolveGraphSyncConfig(raw: RawGraphSyncConfig | undefined): GraphSyncConfig {
  const block = raw ?? {};
  return {
    enabled: readBoolean(block.enabled, 'enabled', DEFAULT_GRAPH_SYNC_CONFIG.enabled),
    minConfidence: readFraction(
      block.min_confidence,
      'min_confidence',
      DEFAULT_GRAPH_SYNC_CONFIG.minConfidence,
    ),
    maxLinksPerRun: readCount(
      block.max_links_per_run,
      'max_links_per_run',
      DEFAULT_GRAPH_SYNC_CONFIG.maxLinksPerRun,
    ),
  };
}
