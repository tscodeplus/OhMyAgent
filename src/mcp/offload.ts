// ---------------------------------------------------------------------------
// MCP integration — oversized tool output: spill to disk, show head + tail
// ---------------------------------------------------------------------------
//
// See MyDocs/MCP_INTEGRATION_DESIGN.md §6.6 and §19-14.
//
// Two deliberate choices live here:
//
//   * The spill goes through `OffloadStore.writeSpill()` — same directory and
//     same hygiene sweep as context offloading, but a *separate ledger*: the
//     output never left the context, so it must not allocate a `node-NNN` id or
//     consume the `maxRefsInContext` budget.
//
//   * The threshold is `mcp.max_output_bytes` and is independent of
//     `memory.offloading.enabled`; the manager owns its own `OffloadStore` for
//     exactly that reason (that switch can leave the agent factory's store
//     undefined).
//
// The path handed to the model is absolute because it must be readable through
// `file_read`; `${baseDir}/offload/` is the one directory that tool always has
// in its allow-list.

import type { LlmContent } from '@earendil-works/pi-mcp';
import type { OffloadStore } from '../runtime-artifacts/offload-store.js';
import type { ToolResultContent } from '../tools/platform/tool-result.js';

export interface McpOutputLimitOptions {
  /** MCP-owned offload store — its `baseDir` is the shared offload root. */
  store: OffloadStore;
  /** `mcp.max_output_bytes` (UTF-8 bytes of the merged text output). */
  maxBytes: number;
  /** Session the tool call belongs to; spills land under its directory. */
  sessionKey: string;
  /** Registered tool name, used as the spill file's path segment. */
  toolName: string;
}

export interface McpLimitedOutput {
  /** What the model sees: truncated text first, then every image block. */
  content: ToolResultContent[];
  truncated: boolean;
  /** Absolute path of the spilled full text; absent when nothing was spilled. */
  fullOutputPath?: string;
}

/**
 * Cap the text output of an MCP tool call at `maxBytes`.
 *
 * Text blocks are merged for the size decision (a server may split one logical
 * output across several blocks), while image blocks are passed through
 * untouched and stay *after* the text so a truncated result never hides them.
 * When the limit is exceeded the verbatim text is spilled and the model gets
 * the head, an omission notice and the tail.
 */
export function limitMcpOutput(
  content: readonly LlmContent[],
  options: McpOutputLimitOptions,
): McpLimitedOutput {
  const text = content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  const images: ToolResultContent[] = content
    .filter((block) => block.type === 'image')
    .map((block) => ({ type: 'image', data: block.data, mimeType: block.mimeType }));

  const totalBytes = Buffer.byteLength(text, 'utf8');
  if (totalBytes <= options.maxBytes) {
    // Under the limit: hand the blocks through untouched (order included), so
    // the common path is exactly `toLlmContent()`'s output.
    return { content: [...content], truncated: false };
  }

  const { absPath } = options.store.writeSpill(options.sessionKey, options.toolName, text);

  const headBudget = Math.floor(options.maxBytes / 2);
  const tailBudget = options.maxBytes - headBudget;
  const head = takeHeadBytes(text, headBudget);
  const tail = takeTailBytes(text, tailBudget);
  const omittedBytes =
    totalBytes - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8');

  const notice =
    `\n\n[Output truncated: ${omittedBytes} bytes omitted]\n` +
    `[Full output: ${absPath} — use file_read to read it]`;

  return {
    content: [{ type: 'text', text: `${head}${notice}\n\n${tail}` }, ...images],
    truncated: true,
    fullOutputPath: absPath,
  };
}

/** Longest prefix of `text` that fits in `maxBytes` UTF-8 bytes, code-point safe. */
function takeHeadBytes(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  while (end < text.length) {
    let next = end + 1;
    const code = text.charCodeAt(end);
    // A high surrogate is half of one code point — take its partner with it so
    // the cut can never leave a lone surrogate (mojibake) behind.
    if (code >= 0xd800 && code <= 0xdbff && next < text.length) next += 1;
    const size = Buffer.byteLength(text.slice(end, next), 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    end = next;
  }
  return text.slice(0, end);
}

/** Longest suffix of `text` that fits in `maxBytes` UTF-8 bytes, code-point safe. */
function takeTailBytes(text: string, maxBytes: number): string {
  let bytes = 0;
  let start = text.length;
  while (start > 0) {
    let index = start - 1;
    const code = text.charCodeAt(index);
    // A low surrogate at the cut point belongs to the pair that starts before it.
    if (code >= 0xdc00 && code <= 0xdfff && index > 0) index -= 1;
    const size = Buffer.byteLength(text.slice(index, start), 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    start = index;
  }
  return text.slice(start);
}
