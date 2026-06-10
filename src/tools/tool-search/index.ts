// ---------------------------------------------------------------------------
// Tool Search — unified public API
// ---------------------------------------------------------------------------

export { tokenize, buildCatalog, searchCatalog, type CatalogEntry } from './bm25.js';
export {
  CORE_TOOL_NAMES,
  BRIDGE_TOOL_NAMES,
  isDeferrable,
  classifyTools,
} from './classifier.js';
export { estimateTokens, shouldActivate } from './threshold.js';
export { loadConfig, type ToolSearchConfig } from './config.js';
export {
  createBridgeTools,
  TOOL_SEARCH_NAME,
  TOOL_DESCRIBE_NAME,
  TOOL_CALL_NAME,
  type BridgeToolDeps,
} from './bridge-tools.js';
export { assembleTools, type AssemblyResult } from './assemble.js';
