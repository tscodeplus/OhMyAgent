/**
 * DAG Executor for plan_and_spawn tool (P4).
 *
 * Validates the subtask dependency graph, groups by topological level,
 * executes each level in parallel (respecting maxConcurrency), and
 * collects results.
 *
 * Strategies:
 *  - `parallel`: all independent subtasks run concurrently
 *  - `sequential`: subtasks run one at a time in order
 *  - `pipeline`: reserved for future iteration (not yet implemented)
 */

import type { Agent } from '../pi-mono/agent/agent.js';
import type { ResolvedAgentConfig } from '../agent/config-types.js';
import type { AgentManager } from '../agent/agent-manager.js';
import type { Orchestrator } from './orchestrator.js';
import type { Logger } from 'pino';
import type {
  SubTaskDef,
  PlanAndSpawnInput,
  SubTaskResult,
  PlanAndSpawnResult,
} from './dag-types.js';

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

export interface DAGExecutorDeps {
  agentManager: AgentManager;
  /** Callback to create an Agent instance from config + task. */
  createAgent: (
    config: ResolvedAgentConfig,
    task: string,
    options?: { sessionId?: string; agentId?: string; policyScope?: any },
  ) => Agent;
  orchestrator: Orchestrator;
  logger: Logger;
  maxConcurrency: number;
  timeoutMs?: number;
}

export class DAGExecutor {
  constructor(private deps: DAGExecutorDeps) {}

  /**
   * Execute a plan. Throws on invalid dependency graph.
   */
  async execute(input: PlanAndSpawnInput): Promise<PlanAndSpawnResult> {
    const strategy = input.strategy;
    if (strategy === 'pipeline') {
      throw new Error('Pipeline strategy is not yet implemented. Use parallel or sequential.');
    }

    // 1. Validate DAG
    this.validateGraph(input.subtasks);

    // 2. Group by topological level
    const levels = this.topologicalSort(input.subtasks);

    // 3. Execute according to strategy
    let results: SubTaskResult[];
    if (strategy === 'sequential') {
      results = await this.executeSequential(input.subtasks, input);
    } else {
      results = await this.executeParallel(levels, input);
    }

    // 4. Combine summaries
    return {
      task: input.task,
      strategy: input.strategy,
      totalSubtasks: input.subtasks.length,
      completed: results.filter(r => r.status === 'completed').length,
      failed: results.filter(r => r.status === 'failed').length,
      blocked: results.filter(r => r.status === 'blocked').length,
      results,
      combinedSummary: buildSummary(input.task, results),
    };
  }

  // ── Validation ──────────────────────────────────────────────────────────────

  private validateGraph(subtasks: SubTaskDef[]): void {
    const titles = new Set(subtasks.map(s => s.title));

    // Check for duplicate titles
    if (titles.size !== subtasks.length) {
      throw new Error('Duplicate subtask titles detected. Each subtask must have a unique title.');
    }

    // Check that all dependsOn references exist
    for (const st of subtasks) {
      if (st.dependsOn) {
        for (const dep of st.dependsOn) {
          if (!titles.has(dep)) {
            throw new Error(
              `Subtask "${st.title}" depends on unknown subtask "${dep}". ` +
              `Available subtasks: ${[...titles].join(', ')}`,
            );
          }
        }
      }
    }

    // Cycle detection via DFS
    this.assertNoCycles(subtasks, titles);
  }

  /**
   * Detect cycles via DFS with color marking.
   * WHITE (0) = unvisited, GRAY (1) = in current path, BLACK (2) = fully explored.
   */
  private assertNoCycles(subtasks: SubTaskDef[], titles: Set<string>): void {
    const color = new Map<string, 0 | 1 | 2>();
    const taskMap = new Map(subtasks.map(s => [s.title, s]));

    function dfs(title: string): void {
      color.set(title, 1); // GRAY — in current path

      const task = taskMap.get(title);
      if (task?.dependsOn) {
        for (const dep of task.dependsOn) {
          const c = color.get(dep) ?? 0;
          if (c === 1) {
            throw new Error(`Cycle detected in subtask dependencies: "${title}" → "${dep}"`);
          }
          if (c === 0) {
            dfs(dep);
          }
        }
      }

      color.set(title, 2); // BLACK — fully explored
    }

    for (const title of titles) {
      if ((color.get(title) ?? 0) === 0) {
        dfs(title);
      }
    }
  }

  // ── Topological Sort ────────────────────────────────────────────────────────

  /**
   * Group subtasks by topological level.
   * Level 0 = no dependencies. Level N = depends only on levels < N.
   */
  private topologicalSort(subtasks: SubTaskDef[]): SubTaskDef[][] {
    const levels: SubTaskDef[][] = [];
    const remaining = new Set(subtasks.map(s => s.title));
    const taskMap = new Map(subtasks.map(s => [s.title, s]));

    while (remaining.size > 0) {
      const level: SubTaskDef[] = [];
      for (const title of remaining) {
        const task = taskMap.get(title)!;
        const deps = task.dependsOn ?? [];
        if (deps.every(d => !remaining.has(d))) {
          level.push(task);
        }
      }
      if (level.length === 0) {
        // Should not happen — cycle detection already passed
        throw new Error('Internal error: unexpected cycle in topological sort');
      }
      for (const t of level) remaining.delete(t.title);
      levels.push(level);
    }
    return levels;
  }

  // ── Sequential Execution ────────────────────────────────────────────────────

  private async executeSequential(
    subtasks: SubTaskDef[],
    input: PlanAndSpawnInput,
  ): Promise<SubTaskResult[]> {
    const results: SubTaskResult[] = [];
    for (const st of subtasks) {
      const result = await this.spawnAndWait(st, input);
      results.push(result);
      if (result.status === 'failed') {
        // Mark remaining as blocked
        for (const remaining of subtasks.slice(results.length)) {
          results.push({
            title: remaining.title,
            status: 'blocked',
            error: 'Upstream task failed',
          });
        }
        break;
      }
    }
    return results;
  }

  // ── Parallel Execution (level by level, chunked by maxConcurrency) ──────────

  private async executeParallel(
    levels: SubTaskDef[][],
    input: PlanAndSpawnInput,
  ): Promise<SubTaskResult[]> {
    const results: SubTaskResult[] = [];
    const limit = input.maxConcurrency ?? this.deps.maxConcurrency;

    for (const level of levels) {
      // Chunk the level so we never exceed maxConcurrency concurrent agents
      const chunks = chunkArray(level, limit);
      const levelResults: SubTaskResult[] = [];

      for (const chunk of chunks) {
        const chunkResults = await Promise.all(
          chunk.map(st => this.spawnAndWait(st, input)),
        );
        levelResults.push(...chunkResults);
      }

      results.push(...levelResults);

      // If any task in this level failed, block downstream tasks
      if (levelResults.some(r => r.status === 'failed')) {
        for (const remaining of levels.slice(levels.indexOf(level) + 1).flat()) {
          results.push({
            title: remaining.title,
            status: 'blocked',
            error: 'Dependency failed in upstream level',
          });
        }
        break;
      }
    }

    return results;
  }

  // ── Spawn single subtask ────────────────────────────────────────────────────

  private async spawnAndWait(
    st: SubTaskDef,
    input: PlanAndSpawnInput,
  ): Promise<SubTaskResult> {
    const startTime = Date.now();

    // Resolve parent context from orchestrator's runtime state
    // We use a placeholder parent — the orchestrator figures out the actual parent
    const parentAgentId = 'orchestrator';

    // Resolve agent config for the requested persona
    const persona = st.persona || 'default';
    const agentConfig = this.deps.agentManager.get(persona);
    if (!agentConfig) {
      return {
        title: st.title,
        status: 'failed',
        error: `Agent persona "${persona}" not found`,
        durationMs: Date.now() - startTime,
      };
    }

    // Use a synthetic session ID — spawnChildAgent creates its own tracking
    const sessionId = `plan-spawn-${Date.now()}-${st.title.replace(/[^a-zA-Z0-9]/g, '-')}`;

    try {
      // Spawn via orchestrator
      const childRun = await this.deps.orchestrator.spawnChildAgent({
        parentAgentId,
        sessionId,
        prompt: st.description,
        requestedScope: {},
      });

      // Create the sub-agent
      const subAgent = this.deps.createAgent(agentConfig, st.description, {
        sessionId,
        agentId: childRun.agentId,
        policyScope: childRun.scope,
      });

      // Register runtime for abort support
      this.deps.orchestrator.registerRuntime({
        agentId: childRun.agentId,
        sessionId,
        abort: () => subAgent.abort(),
        waitForIdle: () => subAgent.waitForIdle(),
      });

      const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

      try {
        const timeoutPromise = new Promise<'timeout'>((resolve) => {
          timeoutTimer = setTimeout(() => resolve('timeout'), timeoutMs);
        });

        const runPromise = (async (): Promise<'completed'> => {
          await subAgent.prompt(st.description);
          await subAgent.waitForIdle();
          return 'completed';
        })();

        const raceResult = await Promise.race([runPromise, timeoutPromise]);

        if (raceResult === 'timeout') {
          subAgent.abort();
          await subAgent.waitForIdle();
          await this.deps.orchestrator.finishAgent(childRun.agentId, 'failed', 'timeout');
          return {
            title: st.title,
            status: 'failed',
            error: `Timed out after ${timeoutMs / 1000}s`,
            agentId: childRun.agentId,
            durationMs: Date.now() - startTime,
          };
        }

        // Extract summary
        const messages = (subAgent.state as any)?.messages ?? [];
        const lastAssistant = [...messages].reverse().find((m: any) => m.role === 'assistant');
        const rawContent = lastAssistant?.content;
        let summary: string;
        if (typeof rawContent === 'string') {
          summary = rawContent.slice(0, 500);
        } else if (Array.isArray(rawContent)) {
          summary = rawContent
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n')
            .slice(0, 500);
        } else {
          summary = '(no output)';
        }

        await this.deps.orchestrator.finishAgent(childRun.agentId, 'completed', summary);

        this.deps.logger.info({
          subtask: st.title,
          agentId: childRun.agentId,
          durationMs: Date.now() - startTime,
        }, 'DAGExecutor: subtask completed');

        return {
          title: st.title,
          status: 'completed',
          summary,
          agentId: childRun.agentId,
          durationMs: Date.now() - startTime,
        };
      } catch (err: any) {
        await this.deps.orchestrator.finishAgent(childRun.agentId, 'failed', err.message);
        return {
          title: st.title,
          status: 'failed',
          error: err.message,
          agentId: childRun.agentId,
          durationMs: Date.now() - startTime,
        };
      } finally {
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        this.deps.orchestrator.unregisterRuntime(childRun.agentId);
      }
    } catch (err: any) {
      return {
        title: st.title,
        status: 'failed',
        error: `Failed to spawn: ${err.message}`,
        durationMs: Date.now() - startTime,
      };
    }
  }
}

// ── Summary Builder ────────────────────────────────────────────────────────

/**
 * Split an array into chunks of at most `size` elements.
 * Used to enforce maxConcurrency without exceeding the concurrent agent limit.
 */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function buildSummary(task: string, results: SubTaskResult[]): string {
  const lines: string[] = [
    `## plan_and_spawn 结果: ${task}`,
    '',
  ];

  for (const r of results) {
    const icon = r.status === 'completed' ? '✅'
      : r.status === 'failed' ? '❌'
      : r.status === 'blocked' ? '🚫'
      : '⏳';
    lines.push(`${icon} **${r.title}** (${r.status})`);
    if (r.summary) {
      lines.push(`   ${r.summary}`);
    }
    if (r.error) {
      lines.push(`   错误: ${r.error}`);
    }
    if (r.durationMs) {
      lines.push(`   耗时: ${(r.durationMs / 1000).toFixed(1)}s`);
    }
    lines.push('');
  }

  const completed = results.filter(r => r.status === 'completed').length;
  const total = results.length;
  lines.push(`---`);
  lines.push(`**进度**: ${completed}/${total} 完成`);

  return lines.join('\n');
}
