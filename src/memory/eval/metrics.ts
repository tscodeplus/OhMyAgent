export interface EvalMetrics {
  recallPrecisionAtK: number;
  personaFreshness: 'fresh' | 'stale' | 'unknown';
  stalePreferenceRate: number;
  inactiveLeakageCount: number;
  averageRetrievalLatencyMs: number;
}

export interface EvalResult {
  metrics: EvalMetrics;
  summary: string;
  timestamp: string;
}
