// ---------------------------------------------------------------------------
// v4 Tool Platform — unified tool execution result
// ---------------------------------------------------------------------------

export type ToolResultContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'file'; path: string; mimeType?: string };

export interface ToolExecutionResult {
  content: ToolResultContent[];
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

/** Create a simple text result. */
export function textResult(text: string, metadata?: Record<string, unknown>): ToolExecutionResult {
  return { content: [{ type: 'text', text }], metadata };
}

/** Create an error result. */
export function errorResult(text: string): ToolExecutionResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Create an image result. */
export function imageResult(data: string, mimeType: string): ToolExecutionResult {
  return { content: [{ type: 'image', data, mimeType }] };
}
