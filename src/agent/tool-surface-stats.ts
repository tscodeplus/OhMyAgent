// ---------------------------------------------------------------------------
// P5 — tool-surface health observability
// ---------------------------------------------------------------------------
//
// Per-turn record of "how many tools actually entered the prompt" plus the
// narrowing mechanisms that produced that number. The tool-call distribution
// and cycle counts come from the existing tool_runs pipeline
// (src/agent/tool-audit.ts); this module completes the other half of the
// comparison: surface size vs. outcome.
//
// In-memory only (bounded ring) — restart resets the window. Log line is
// emitted per turn at debug level so deployments can pipe it into metrics
// without changing any DB schema.

export interface ToolSurfaceTurnStats {
  sessionId: string;
  /** Effective capability-domain profile for the turn */
  profile: string;
  /** True when a skill strict surface owned the turn */
  skillStrict: boolean;
  /** Detected intent domain, if narrowing applied (P4) */
  intentDomain?: string;
  /** Tools that entered the model-facing prompt after all pipeline stages */
  visibleCount: number;
  /** Tools held back by tool-search deferral (undefined when tool search off) */
  deferredCount?: number;
  /** Tool-search auto-activation fired this turn */
  toolSearchActivated?: boolean;
  at: number;
}

const RING_CAPACITY = 500;
const ring: ToolSurfaceTurnStats[] = [];

export function recordToolSurfaceTurn(stats: ToolSurfaceTurnStats): void {
  ring.push(stats);
  if (ring.length > RING_CAPACITY) {
    ring.splice(0, ring.length - RING_CAPACITY);
  }
}

export interface ToolSurfaceSnapshot {
  windowSize: number;
  avgVisibleTools: number;
  avgDeferredTools: number | undefined;
  narrowTurns: number;
  narrowRate: number;
  strictTurns: number;
  byProfile: Record<string, number>;
  byIntentDomain: Record<string, number>;
}

/** Aggregate over the recorded ring window. */
export function getToolSurfaceSnapshot(): ToolSurfaceSnapshot {
  if (ring.length === 0) {
    return {
      windowSize: 0,
      avgVisibleTools: 0,
      avgDeferredTools: undefined,
      narrowTurns: 0,
      narrowRate: 0,
      strictTurns: 0,
      byProfile: {},
      byIntentDomain: {},
    };
  }

  const sumVisible = ring.reduce((acc, t) => acc + t.visibleCount, 0);
  const withDeferred = ring.filter((t) => t.deferredCount !== undefined);
  const sumDeferred = withDeferred.reduce((acc, t) => acc + (t.deferredCount ?? 0), 0);
  const narrowTurns = ring.filter((t) => t.intentDomain !== undefined).length;
  const strictTurns = ring.filter((t) => t.skillStrict).length;

  const byProfile: Record<string, number> = {};
  for (const t of ring) byProfile[t.profile] = (byProfile[t.profile] ?? 0) + 1;

  const byIntentDomain: Record<string, number> = {};
  for (const t of ring) {
    if (t.intentDomain) byIntentDomain[t.intentDomain] = (byIntentDomain[t.intentDomain] ?? 0) + 1;
  }

  return {
    windowSize: ring.length,
    avgVisibleTools: Math.round((sumVisible / ring.length) * 10) / 10,
    avgDeferredTools:
      withDeferred.length > 0
        ? Math.round((sumDeferred / withDeferred.length) * 10) / 10
        : undefined,
    narrowTurns,
    narrowRate: Math.round((narrowTurns / ring.length) * 1000) / 1000,
    strictTurns,
    byProfile,
    byIntentDomain,
  };
}

/** Test hook — clear the in-memory window. */
export function resetToolSurfaceStats(): void {
  ring.length = 0;
}
