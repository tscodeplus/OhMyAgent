/**
 * Mermaid Canvas updater — shared helper to avoid duplication between
 * offloading-enabled and offloading-disabled code paths in agent-factory.ts.
 *
 * Extracted from the afterToolCall callback where the Mermaid node recording
 * and LLM phase-tagging logic appeared identically in both branches.
 */

import type { Logger } from 'pino';
import type { MermaidCanvas } from '../runtime-artifacts/mermaid-canvas.js';
import type { MermaidPhaseTagger } from '../runtime-artifacts/mermaid-phase-tagger.js';

export interface MermaidNodeData {
  nodeId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  summary: string;
  status: string;
  seq: number;
  refPath?: string;
}

export interface MermaidCanvasUpdateOptions {
  canvas: MermaidCanvas | undefined;
  config: { enabled?: boolean; phaseTagging?: string };
  node: MermaidNodeData;
  sessionId?: string;
  logger?: Logger;
  /** Lazy-initialize/return the phase tagger. Called every 5 steps for LLM tagging. */
  ensurePhaseTagger: () => MermaidPhaseTagger | undefined;
}

/**
 * Record a tool result node on the Mermaid canvas and optionally run LLM
 * phase tagging (every 5 nodes). All errors are caught silently — Mermaid
 * updates must never block the tool result.
 */
export function updateMermaidCanvas(opts: MermaidCanvasUpdateOptions): void {
  const { canvas, config, node, sessionId, logger, ensurePhaseTagger } = opts;

  if (!config.enabled || !canvas) return;

  try {
    canvas.addNode(node as any);
    logger?.debug(
      {
        sessionId,
        nodeId: node.nodeId,
        toolName: node.toolName,
        status: node.status,
        nodeCount: canvas.size,
      },
      'Mermaid canvas node recorded',
    );

    if (config.phaseTagging === 'llm' && canvas.size % 5 === 0 && logger) {
      const tagger = ensurePhaseTagger();
      if (tagger) {
        tagger
          .tagPhases(canvas.getAllNodes())
          .then((tagResult) => {
            if (tagResult) tagger.applyToCanvas(canvas, tagResult);
          })
          .catch(() => {});
      }
    }
  } catch {
    // Mermaid canvas update should not block the tool result
  }
}
