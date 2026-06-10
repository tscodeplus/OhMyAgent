// ---------------------------------------------------------------------------
// v4 Tool Platform — canonical ToolCapabilityDescriptor definition
// ---------------------------------------------------------------------------

import type { ToolCategory } from './tool-definition.js';

/**
 * Every tool registered in the v4 ToolRegistry must provide a capability
 * descriptor.  The PolicyCenter uses this to decide visibility, path checks,
 * and default approval behaviour without hard-coding per-tool knowledge.
 */
export interface ToolCapabilityDescriptor {
  category: ToolCategory;
  readOnly: boolean;
  readsFiles: boolean;
  writesFiles: boolean;
  usesShell: boolean;
  usesNetwork: boolean;
  usesComputerUse: boolean;
  pathAccess: 'none' | 'read' | 'write' | 'read_write';
  approvalDefault: 'none' | 'mutating' | 'high_risk';
}
