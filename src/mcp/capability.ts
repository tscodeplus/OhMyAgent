// ---------------------------------------------------------------------------
// MCP integration — server annotations → v4 tool capability descriptor
// ---------------------------------------------------------------------------
//
// See MyDocs/MCP_INTEGRATION_DESIGN.md §8.1.
//
// MCP `annotations` are *hints* supplied by the server, and the spec explicitly
// calls them untrusted. They are therefore treated as a fail-closed relaxation
// switch: a tool only loses its approval requirement when it positively declares
// `readOnlyHint`, and `destructiveHint` always wins over it (a server that marks
// a tool both read-only and destructive is contradicting itself, and the safe
// reading is the destructive one).
//
// `usesNetwork` cannot be derived from annotations at all; an HTTP transport
// necessarily talks to the network, while a stdio server may or may not. It is
// therefore reported as `false` for stdio — the conservative choice for the
// policy layer's "no network access needed" checks is to not claim network use
// we cannot observe.

import type { ToolAnnotations } from '@earendil-works/pi-mcp';
import type { ToolCapabilityDescriptor } from '../tools/platform/tool-capabilities.js';
import type { McpServerConfig } from './types.js';

/** The four annotation flags surfaced on `McpToolView` (design §13.7). */
export interface McpAnnotationFlags {
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
}

/**
 * Read the annotation flags, normalising absent hints to `false`.
 *
 * Absent is *not* "not read-only" — it is unknown, and every consumer of these
 * flags (approval card badges, `McpToolView`) renders them as positive claims.
 */
export function mcpAnnotationFlags(annotations: ToolAnnotations | undefined): McpAnnotationFlags {
  return {
    readOnly: annotations?.readOnlyHint === true,
    destructive: annotations?.destructiveHint === true,
    idempotent: annotations?.idempotentHint === true,
    openWorld: annotations?.openWorldHint === true,
  };
}

/**
 * Map one MCP tool's annotations onto the capability descriptor the v4 tool
 * platform and PolicyCenter consume (design §8.1).
 *
 * Approval default ladder:
 *   `destructiveHint: true`          → `high_risk` (always needs approval)
 *   `readOnlyHint: true`             → `none`      (auto-approved)
 *   absent / unknown annotations     → `mutating`  (first call needs approval)
 *
 * A tool that declares no annotations at all is where the server-level
 * `trust: read_only | normal | high_risk` override applies (§8.1), because a
 * server that does not annotate cannot be distinguished from a dangerous one.
 * Annotations always win when they exist: a tool that declares a hint makes a
 * more specific statement than the server-wide default, so `trust: high_risk`
 * must not override a tool's own `readOnlyHint`.
 *
 * Registered through `registerToolCapability()` so `approvalRiskForTool()`
 * agrees with the v4 policy path (`AgentToolAdapterImpl` passes this very
 * descriptor to `policyCenter.evaluateToolCall`).
 */
export function capabilityFromAnnotations(
  annotations: ToolAnnotations | undefined,
  server: McpServerConfig,
): ToolCapabilityDescriptor {
  const flags = mcpAnnotationFlags(annotations);

  // `{}` carries no hint, so it counts as "no annotations" for the override.
  const unannotated = annotations === undefined || Object.keys(annotations).length === 0;
  // `trust: 'normal'` is the ladder below, so it is deliberately a no-op here
  // rather than a third branch with the same result.
  const trust =
    unannotated && server.trust !== undefined && server.trust !== 'normal'
      ? server.trust
      : undefined;

  const readOnly =
    trust === undefined ? flags.readOnly && !flags.destructive : trust === 'read_only';
  const destructive = trust === undefined ? flags.destructive : trust === 'high_risk';

  return {
    category: 'mcp',
    readOnly,
    readsFiles: false,
    writesFiles: false,
    usesShell: false,
    usesNetwork: server.transport === 'http',
    usesComputerUse: false,
    pathAccess: 'none',
    approvalDefault: destructive ? 'high_risk' : readOnly ? 'none' : 'mutating',
  };
}
