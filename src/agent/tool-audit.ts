/**
 * Tool Run Audit
 *
 * Extracted from agent-service.ts. Subscribes to agent tool-execution events
 * and records them in the tool_run_repository for audit and billing purposes.
 */

import type { Agent } from '../pi-mono/agent/agent.js';
import type { AgentEvent } from '../pi-mono/agent/types.js';
import type { ToolRunRepository } from '../memory/repositories/tool-run-repository.js';
import { truncate } from '../shared/truncation.js';
import { extractText } from '../shared/text-extract.js';

// ── Helpers ──

function summarizeToolArgs(args: unknown): string {
  if (!args || typeof args !== 'object') {
    return truncate(String(args ?? ''), 240);
  }
  if ('command' in (args as Record<string, unknown>) && typeof (args as Record<string, unknown>).command === 'string') {
    return truncate((args as Record<string, unknown>).command as string, 240);
  }
  return truncate(JSON.stringify(args), 240);
}

function summarizeToolResult(result: unknown): string {
  const text = extractText((result as { content?: unknown } | null)?.content ?? result);
  return truncate(text, 500);
}

// ── Subscribe ──

export function subscribeToolRunAudit(
  agent: Agent,
  sessionId: string,
  toolRunRepository: ToolRunRepository,
): () => void {
  const startedAt = new Map<string, number>();
  const toolNames = new Map<string, string>();

  return agent.subscribe((event: AgentEvent) => {
    if (event.type === 'tool_execution_start') {
      startedAt.set(event.toolCallId, Date.now());
      toolNames.set(event.toolCallId, event.toolName);
      const runId = `${sessionId}:${event.toolCallId}`;
      toolRunRepository.create({
        id: runId,
        session_id: sessionId,
        tool_name: event.toolName,
        input: summarizeToolArgs(event.args),
        status: 'started',
        metadata: JSON.stringify({ toolCallId: event.toolCallId }),
      });
      return;
    }

    if (event.type === 'tool_execution_end') {
      const started = startedAt.get(event.toolCallId);
      const durationMs = started ? Date.now() - started : null;
      const runId = `${sessionId}:${event.toolCallId}`;
      toolRunRepository.update(runId, {
        output: summarizeToolResult(event.result),
        status: event.isError ? 'error' : 'success',
        duration_ms: durationMs,
        error: event.isError ? summarizeToolResult(event.result) : null,
        metadata: JSON.stringify({
          toolCallId: event.toolCallId,
          toolName: toolNames.get(event.toolCallId) ?? event.toolName,
          isError: event.isError,
        }),
      });
      startedAt.delete(event.toolCallId);
      toolNames.delete(event.toolCallId);
    }
  });
}
