/**
 * DAG Types for plan_and_spawn tool (P4).
 *
 * Supports `parallel` and `sequential` execution strategies.
 * `pipeline` is declared but reserved for a future iteration.
 */

export interface SubTaskDef {
  title: string;
  description: string;
  persona?: string;
  dependsOn?: string[];
}

export interface PlanAndSpawnInput {
  task: string;
  subtasks: SubTaskDef[];
  strategy: 'parallel' | 'sequential' | 'pipeline';
  maxConcurrency?: number;
}

export type SubTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked';

export interface SubTaskResult {
  title: string;
  status: SubTaskStatus;
  summary?: string;
  error?: string;
  agentId?: string;
  durationMs?: number;
}

export interface PlanAndSpawnResult {
  task: string;
  strategy: string;
  totalSubtasks: number;
  completed: number;
  failed: number;
  blocked: number;
  results: SubTaskResult[];
  combinedSummary: string;
}
