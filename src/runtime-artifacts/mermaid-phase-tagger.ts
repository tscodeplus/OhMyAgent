/**
 * MermaidPhaseTagger — LLM-driven semantic phase labeling for MermaidCanvas nodes.
 *
 * Uses a DistillerLLM to group tool-execution nodes into meaningful phases
 * (e.g., "Setup", "Analysis", "Deployment") and assigns each node to a phase.
 *
 * Falls back gracefully: returns `null` when the LLM call fails or when there
 * are fewer than 3 nodes (not enough context for meaningful phase detection).
 */

import type { Logger } from 'pino';
import type { DistillerLLM } from '../memory/persona-distiller.js';
import type { MermaidCanvas, MermaidNode } from './mermaid-canvas.js';

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface PhaseTaggingResult {
  /** Ordered list of unique phase names, e.g. ["Environment Check", "Config Analysis", "Deployment"]. */
  phases: string[];
  /** Mapping from node ID to phase name, e.g. {"node-001": "Environment Check", ...}. */
  mapping: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  'You are a precise task phase analyst. Based on tool execution records, divide the task into semantic phases and label each node. Output ONLY valid JSON, no other text.';

const MIN_NODES_FOR_LLM = 3;
const MAX_PHASES = 5;

// ---------------------------------------------------------------------------
// MermaidPhaseTagger
// ---------------------------------------------------------------------------

export class MermaidPhaseTagger {
  constructor(
    private readonly llm: DistillerLLM,
    private readonly logger: Logger,
  ) {}

  /**
   * Use the LLM to assign semantic phase labels to a list of nodes.
   *
   * @param nodes — node list from `MermaidCanvas.getAllNodes()`
   * @returns `PhaseTaggingResult` on success, or `null` when there are fewer
   *          than 3 nodes or the LLM call fails
   */
  async tagPhases(nodes: MermaidNode[]): Promise<PhaseTaggingResult | null> {
    if (nodes.length < MIN_NODES_FOR_LLM) {
      this.logger.debug(
        { nodeCount: nodes.length },
        'Too few nodes for LLM phase tagging, skipping',
      );
      return null;
    }

    const userPrompt = this.buildPrompt(nodes);

    try {
      const response = await this.llm.call(SYSTEM_PROMPT, userPrompt);
      return this.parseResponse(response, nodes);
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Mermaid phase tagger LLM call failed',
      );
      return null;
    }
  }

  /**
   * Apply a phase tagging result to a MermaidCanvas, updating each node's
   * `phase` field in place.
   *
   * Node IDs that exist in the mapping but not in the canvas are silently
   * skipped.
   */
  applyToCanvas(canvas: MermaidCanvas, result: PhaseTaggingResult): void {
    for (const [nodeId, phase] of Object.entries(result.mapping)) {
      const node = canvas.getNode(nodeId);
      if (node) {
        node.phase = phase;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Build the user prompt from a list of nodes.
   */
  private buildPrompt(nodes: MermaidNode[]): string {
    const lines: string[] = [
      'Based on the following tool execution records, divide into task phases (max 5 phases) and label each node with its phase:',
      '',
    ];

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const statusLabel = n.status === 'error' ? 'failed' : 'success';
      const summaryPart = n.summary ? `: ${n.summary}` : '';
      lines.push(
        `${i + 1}. [${n.id}] ${n.toolName}: ${summaryPart} → ${statusLabel}`,
      );
    }

    lines.push('');
    lines.push(
      'Return JSON: {"phases": ["Phase One", "Phase Two", ...], "mapping": {"node-xxx": "Phase One", ...}}',
    );

    return lines.join('\n');
  }

  /**
   * Parse the LLM response into a PhaseTaggingResult.
   *
   * Returns `null` when the response cannot be parsed or fails validation.
   */
  private parseResponse(
    response: string,
    nodes: MermaidNode[],
  ): PhaseTaggingResult | null {
    const cleaned = extractJson(response);
    if (!cleaned) {
      this.logger.warn('No valid JSON found in LLM response for phase tagging');
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      this.logger.warn('Failed to parse LLM response JSON for phase tagging');
      return null;
    }

    if (!isValidPhaseTaggingResult(parsed)) {
      this.logger.warn(
        { parsed },
        'LLM response JSON does not match PhaseTaggingResult schema',
      );
      return null;
    }

    const result = parsed as PhaseTaggingResult;

    // Validate: every input node should have a mapping entry (warn but accept)
    const missingNodes = nodes.filter((n) => !(n.id in result.mapping));
    if (missingNodes.length > 0) {
      this.logger.warn(
        { missingNodeIds: missingNodes.map((n) => n.id) },
        'Some nodes are missing from LLM phase mapping',
      );
    }

    // Remove mapping entries for unknown node IDs (not in our input)
    const validNodeIds = new Set(nodes.map((n) => n.id));
    const cleanedMapping: Record<string, string> = {};
    for (const [nodeId, phase] of Object.entries(result.mapping)) {
      if (validNodeIds.has(nodeId)) {
        cleanedMapping[nodeId] = phase;
      }
    }

    return { phases: result.phases, mapping: cleanedMapping };
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

import { extractJson } from '../memory/json-utils.js';

/**
 * Validate that an unknown value conforms to the PhaseTaggingResult shape.
 */
function isValidPhaseTaggingResult(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;

  const obj = value as Record<string, unknown>;

  // `phases` must be a non-empty array of strings
  if (!Array.isArray(obj.phases) || obj.phases.length === 0) {
    return false;
  }
  if (!obj.phases.every((p: unknown) => typeof p === 'string')) {
    return false;
  }
  if (obj.phases.length > MAX_PHASES) {
    return false;
  }

  // `mapping` must be a non-null object with string values
  if (
    typeof obj.mapping !== 'object' ||
    obj.mapping === null ||
    Array.isArray(obj.mapping)
  ) {
    return false;
  }
  const mappingValues = Object.values(obj.mapping);
  if (!mappingValues.every((v: unknown) => typeof v === 'string')) {
    return false;
  }

  return true;
}
