// ---------------------------------------------------------------------------
// Cron system type definitions
// ---------------------------------------------------------------------------

/**
 * Schedule type discriminated by `type`.
 */
export type CronSchedule =
  | { type: 'interval'; intervalMs: number }
  | { type: 'cron'; expression: string; timezone?: string }
  | { type: 'oneshot'; timestampMs: number };

/**
 * Human-readable schedule string for display / command input.
 *
 * Accepted formats:
 *   "every 30m" | "every 2h" | "every 1d"
 *   "0 8,15 * * *"
 *   "at 2026-05-04T15:00:00Z"
 *   "30m" | "2h"  (relative delay from now, oneshot)
 */
export type ScheduleInput = string;

export type JobState = 'idle' | 'running' | 'paused' | 'completed';
export type RunStatus = 'success' | 'error' | 'timeout' | 'cancelled';

export interface CronJob {
  /** 8-character short ID. */
  id: string;
  /** Human-readable name, e.g. "Morning news briefing". */
  name: string;
  /** Optional description for display in WebUI. */
  description?: string;
  /** The parsed schedule definition. */
  schedule: CronSchedule;
  /** Original schedule input string for display and re-parsing. */
  scheduleText: string;
  /** Prompt sent to the agent when the job fires. */
  prompt: string;
  /** Channel-specific chat/user ID for result delivery. */
  chatId: string;
  /** Channel identifier: "feishu", "wechat", "qq", "telegram", etc. */
  channel: string;
  /** Agent name that created this job (for display in delivery footer). */
  agentName?: string;
  /** Agent ID that created this job. Cron execution uses this to select the correct model. */
  agentId?: string;
  /** Permission snapshot from job creation. Cron can use Computer Use only when this is true. */
  computerUseAllowed?: boolean;
  /** Whether the job is active. */
  enabled: boolean;
  /** Mutable runtime state. */
  state: JobState;
  /** Epoch ms of the next scheduled run. null when completed or oneshot done. */
  nextRunAt: number | null;
  /** Epoch ms of the most recent run attempt. */
  lastRunAt: number | null;
  /** Status of the most recent run attempt. */
  lastStatus: RunStatus | null;
  /** Consecutive failure count for exponential backoff. */
  retryCount: number;
  /** Job metadata. */
  createdAt: number;
  updatedAt: number;
  /** Error message from last failure, if any. */
  lastError?: string;
  /** Epoch ms after which the job stops running. Scheduler auto-completes it. */
  endAt?: number;
}

/**
 * The shape persisted to cron-jobs.json.
 */
export interface CronStoreData {
  version: 1;
  jobs: CronJob[];
}

/**
 * Result of a single job execution.
 */
export interface JobRunResult {
  jobId: string;
  status: RunStatus;
  output: string;
  durationMs: number;
  error?: string;
  deliveredToChat: boolean;
}
