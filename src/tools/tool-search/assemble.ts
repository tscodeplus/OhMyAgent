// ---------------------------------------------------------------------------
// Tool Search assembly — the main pipeline
// ---------------------------------------------------------------------------
//
// ``assembleTools`` is the single public entry point that classifies tools,
// estimates token costs, and (when the threshold is met) marks deferrable
// tools with ``deferred: true`` and adds a single tool_search bridge that
// handles both search and invoke.
//
// Deferred tools STAY in the returned ``tools`` array (flagged) so the agent
// loop can resolve them by name for direct invocation; they are hidden from
// the LLM prompt by ``compactToolsForPrompt`` (which skips ``deferred`` tools).
//
// Design: tool_search serves dual purpose:
//   1. Search: tool_search({ query: "rebuild persona" }) → returns matches
//   2. Invoke: tool_search({ query: "memory_rebuild_persona", invoke: true, arguments: {...} })
// This reduces the progressive-disclosure workflow to 1-2 steps instead of 3,
// which works reliably with DeepSeek models.

import type { AgentTool } from '../../pi-mono/agent/types.js';
import type { ToolSearchConfig } from './config.js';
import { classifyTools, BRIDGE_TOOL_NAMES } from './classifier.js';
import { estimateTokens, shouldActivate } from './threshold.js';
import { createBridgeTools, TOOL_SEARCH_NAME } from './bridge-tools.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AssemblyResult {
  tools: AgentTool[];
  activated: boolean;
  deferredCount: number;
  deferredTokens: number;
  thresholdTokens: number;
  deferredCatalog: Map<string, AgentTool>;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export function assembleTools(
  tools: AgentTool[],
  config: ToolSearchConfig,
  contextLength: number,
  forceVisible?: ReadonlySet<string>,
): AssemblyResult {
  // Defensive: strip any bridge tools that may already be in the list
  const incoming = tools.filter(
    (t) => !BRIDGE_TOOL_NAMES.has(t.name),
  );

  const classified = classifyTools(incoming);
  const visible = classified.visible;
  // Tools named in forceVisible are never deferred (e.g. channel-injected
  // extraTools that must always stay directly callable AND prompt-visible).
  const deferrable = forceVisible
    ? classified.deferrable.filter((t) => !forceVisible.has(t.name))
    : classified.deferrable;
  const forced = forceVisible
    ? classified.deferrable.filter((t) => forceVisible.has(t.name))
    : [];

  const passthrough = (): AssemblyResult => ({
    tools: incoming,
    activated: false,
    deferredCount: deferrable.length,
    deferredTokens: deferrable.length > 0 ? estimateTokens(deferrable) : 0,
    thresholdTokens: contextLength > 0
      ? Math.floor(contextLength * (config.thresholdPct / 100))
      : 0,
    deferredCatalog: new Map(),
  });

  if (deferrable.length === 0) return passthrough();

  const deferredTokens = estimateTokens(deferrable);

  if (!shouldActivate(config, deferredTokens, contextLength)) {
    return passthrough();
  }

  // Build deferred catalog AND flag each deferred tool. The flagged copies stay
  // in the returned tools array so the agent loop can still resolve them by name
  // (direct invocation), while compactToolsForPrompt hides them from the LLM.
  // The catalog references the SAME flagged objects so bridge invoke + direct
  // call hit identical (policy-wrapped) tools.
  const deferredCatalog = new Map<string, AgentTool>();
  const deferredFlagged: AgentTool[] = [];
  for (const t of deferrable) {
    const flagged: AgentTool = { ...t, deferred: true };
    deferredCatalog.set(flagged.name, flagged);
    deferredFlagged.push(flagged);
  }

  // Create tool_search bridge (search + invoke in one tool)
  const [searchBridge] = createBridgeTools({
    deferredCatalog,
    allTools: incoming,
    config,
    activated: true,
  });

  // Replace standalone tool_search with the bridge version; keep forced-visible
  // tools (e.g. extraTools) in the model-facing list unchanged.
  const visibleDeduped = [...visible, ...forced].filter((t) => t.name !== TOOL_SEARCH_NAME);

  return {
    tools: [...visibleDeduped, searchBridge, ...deferredFlagged],
    activated: true,
    deferredCount: deferrable.length,
    deferredTokens,
    thresholdTokens: Math.floor(contextLength * (config.thresholdPct / 100)),
    deferredCatalog,
  };
}
