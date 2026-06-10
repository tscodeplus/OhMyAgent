export interface MaintenanceJobResult {
  name: string;
  status: 'success' | 'failed' | 'skipped';
  dryRun: boolean;
  affectedRows: number;
  durationMs: number;
  error?: string;
  details?: Record<string, unknown>;
}

export interface MaintenanceJob {
  name: string;
  enabled: boolean;
  intervalMs: number;
  run(input: { dryRun: boolean; signal?: AbortSignal }): Promise<MaintenanceJobResult>;
}
