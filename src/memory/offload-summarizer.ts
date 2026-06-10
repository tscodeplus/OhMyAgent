/**
 * OffloadSummarizer — rule-based tool result summarizer for context offloading.
 *
 * Generates a concise 1-2 line Chinese summary of a tool execution result
 * without calling an LLM. Each tool type has a dedicated template that
 * extracts key data points (line count, bytes, HTTP status, result count, etc.).
 *
 * Used by P0-T3 (afterToolCall hook) to replace full tool results in the
 * LLM message array with short summaries.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

function countLines(text: string): number {
  if (!text) return 0;
  const lines = text.split(/\r?\n/);
  // Trailing newline produces an empty last element; don't count it
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    return lines.length - 1;
  }
  return lines.length;
}

function countBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Normalise a tool name for matching: lowercase, replace dashes with underscores.
 */
function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/-/g, '_');
}

/**
 * Try to parse a string as a JSON object.
 * Returns `null` on failure or if the result is not a plain object.
 */
function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Try to parse a string as a JSON array.
 * Returns `null` on failure or if the result is not an array.
 */
function tryParseJsonArray(text: string): unknown[] | null {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Collapse whitespace and trim to create a single-line text preview.
 */
function getTextPreview(text: string, maxLen: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return truncate(cleaned, maxLen);
}

/**
 * Safely read a string value from an args record by trying multiple candidate keys.
 */
function getArgString(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const val = args[key];
    if (typeof val === 'string') return val;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalise a tool result to plain text.
 *
 * Handles three common formats:
 * - `string` — returned as-is
 * - `TextBlock[]` (e.g. `[{type:'text', text:...}]`) — extracts and joins text fields
 * - `string[]` — joined with newlines
 * - Any other value — JSON-stringified
 */
export function normalizeResult(result: unknown): string {
  if (typeof result === 'string') return result;

  if (Array.isArray(result)) {
    const parts: string[] = [];
    for (const item of result) {
      if (typeof item === 'string') {
        parts.push(item);
      } else if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        if (obj.type === 'text' && typeof obj.text === 'string') {
          parts.push(obj.text);
        } else {
          parts.push(JSON.stringify(item));
        }
      } else {
        parts.push(String(item));
      }
    }
    return parts.join('\n');
  }

  if (result === null || result === undefined) return '';
  return JSON.stringify(result);
}

/**
 * Safely extract a summary-friendly args object from tool arguments.
 *
 * - If `args` is already a plain object, returns it directly.
 * - If `args` is a JSON string, attempts to parse it.
 * - Otherwise wraps the raw value in `{ raw }`.
 */
export function extractArgsSummary(args: unknown): Record<string, unknown> {
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { raw: args };
    } catch {
      return { raw: args };
    }
  }
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return {};
}

// ---------------------------------------------------------------------------
// Tool-type-specific summarizers
// ---------------------------------------------------------------------------

function summarizeShell(
  toolName: string,
  args: Record<string, unknown>,
  resultText: string,
): string {
  const cmd = truncate(getArgString(args, 'command', 'cmd'), 80);
  const lines = countLines(resultText);
  return `执行 shell 命令 \`${cmd}\`，输出 ${lines} 行`;
}

function summarizeFileRead(
  args: Record<string, unknown>,
  resultText: string,
): string {
  const path = getArgString(args, 'path', 'file_path', 'filePath');
  const size = countBytes(resultText);
  const lines = countLines(resultText);
  return `读取文件 \`${path}\`，${size} 字节，共 ${lines} 行`;
}

function summarizeFileWrite(
  args: Record<string, unknown>,
  resultText: string,
): string {
  const path = getArgString(args, 'path', 'file_path', 'filePath', 'filepath');
  // Try to get written byte count from a JSON-like result first
  let bytes: number;
  const parsed = tryParseJson(resultText);
  if (parsed && typeof parsed.bytes === 'number') {
    bytes = parsed.bytes;
  } else if (parsed && typeof parsed.size === 'number') {
    bytes = parsed.size;
  } else {
    bytes = countBytes(resultText);
  }
  return `写入文件 \`${path}\`，${bytes} 字节`;
}

function summarizeHttp(
  args: Record<string, unknown>,
  resultText: string,
): string {
  const method = (getArgString(args, 'method', 'httpMethod') || 'GET').toUpperCase();
  const url = getArgString(args, 'url', 'uri', 'endpoint');

  let statusCode = '?';
  let responseSize: number;

  const parsed = tryParseJson(resultText);
  if (parsed) {
    statusCode = String(
      parsed.statusCode ?? parsed.status_code ?? parsed.status ?? parsed.code ?? '?',
    );
    responseSize =
      typeof parsed.responseSize === 'number'
        ? parsed.responseSize
        : typeof parsed.response_size === 'number'
          ? parsed.response_size
          : typeof parsed.body === 'string'
            ? countBytes(parsed.body as string)
            : countBytes(resultText);
  } else {
    responseSize = countBytes(resultText);
  }

  return `${method} ${url} → HTTP ${statusCode}，${responseSize} 字节`;
}

function summarizeSearch(
  args: Record<string, unknown>,
  resultText: string,
): string {
  const query = getArgString(args, 'query', 'q', 'keyword', 'keywords');

  let resultCount = 0;
  const parsed = tryParseJson(resultText);
  if (parsed) {
    if (typeof parsed.total === 'number') {
      resultCount = parsed.total;
    } else if (typeof parsed.totalResults === 'number') {
      resultCount = parsed.totalResults;
    } else if (typeof parsed.count === 'number') {
      resultCount = parsed.count;
    } else if (Array.isArray(parsed.results)) {
      resultCount = parsed.results.length;
    } else if (Array.isArray(parsed.items)) {
      resultCount = parsed.items.length;
    }
  } else {
    const arr = tryParseJsonArray(resultText);
    if (arr) {
      resultCount = arr.length;
    } else {
      resultCount = countLines(resultText);
    }
  }

  return `搜索 "${query}" → ${resultCount} 条结果`;
}

function summarizeMemoryStore(
  args: Record<string, unknown>,
  resultText: string,
): string {
  const content = getArgString(args, 'content', 'text', 'memory');
  const preview = truncate(content || resultText, 40);
  return `存储记忆: ${preview}...`;
}

function summarizeMemoryRecall(
  args: Record<string, unknown>,
  resultText: string,
): string {
  const query = getArgString(args, 'query', 'q', 'keyword', 'content');
  return `记忆召回: ${query || getTextPreview(resultText, 60)}`;
}

function summarizeDefault(toolName: string, resultText: string): string {
  const summary = getTextPreview(resultText, 100);
  return `${toolName}: ${summary}`;
}

function summarizeError(toolName: string, resultText: string): string {
  // Try to extract a clean error message from JSON structure first
  let errorMsg: string;
  const parsed = tryParseJson(resultText);
  if (parsed) {
    errorMsg =
      getArgString(parsed, 'error', 'message', 'errorMessage', 'error_message') || resultText;
  } else {
    errorMsg = resultText;
  }
  return `❌ ${toolName}: 执行失败 — ${getTextPreview(errorMsg, 80)}`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Generate a concise Chinese summary for a tool execution result.
 *
 * **Success templates** (when `isError` is falsy):
 * - `shell` / `bash` / `exec` →  "执行 shell 命令 `{cmd}`，输出 {lines} 行"
 * - `file_read` / `read_file` → "读取文件 `{path}`，{size} 字节，共 {lines} 行"
 * - `file_write` / `write_file` → "写入文件 `{path}`，{size} 字节"
 * - `http_request` / `fetch` / `web_fetch` → "{method} {url} → HTTP {statusCode}，{responseSize} 字节"
 * - `web_search` / `search` → "搜索 "{query}" → {resultCount} 条结果"
 * - `memory-store` / `memory_store` → "存储记忆: {content(前40字符)}..."
 * - `memory-recall` / `memory_recall` → "记忆召回: {query}"
 * - Default → "{toolName}: {resultSummary(前100字符)}"
 *
 * **Error template** (when `isError` is truthy):
 * - "❌ {toolName}: 执行失败 — {errorMessage(前80字符)}"
 *
 * The output is always limited to 200 characters with truncation protection.
 *
 * @param toolName - The name of the executed tool.
 * @param args     - Tool arguments (object or JSON string).
 * @param result   - Tool result (string, string[], or TextBlock[]).
 * @param isError  - Whether the tool execution failed.
 * @returns A 1-2 line Chinese summary string.
 */
export function summarizeToolResult(
  toolName: string,
  args: unknown,
  result: unknown,
  isError?: boolean,
): string {
  const normalizedName = normalizeToolName(toolName);
  const argsObj = extractArgsSummary(args);
  const resultText = normalizeResult(result);

  // -- Error path -----------------------------------------------------------
  if (isError) {
    return truncate(summarizeError(toolName, resultText), 200);
  }

  // -- Success paths by tool type -------------------------------------------
  let summary: string;

  if (['shell', 'bash', 'exec'].includes(normalizedName)) {
    summary = summarizeShell(toolName, argsObj, resultText);
  } else if (['file_read', 'read_file'].includes(normalizedName)) {
    summary = summarizeFileRead(argsObj, resultText);
  } else if (['file_write', 'write_file'].includes(normalizedName)) {
    summary = summarizeFileWrite(argsObj, resultText);
  } else if (['http_request', 'fetch', 'web_fetch'].includes(normalizedName)) {
    summary = summarizeHttp(argsObj, resultText);
  } else if (['web_search', 'search'].includes(normalizedName)) {
    summary = summarizeSearch(argsObj, resultText);
  } else if (['memory_store'].includes(normalizedName)) {
    summary = summarizeMemoryStore(argsObj, resultText);
  } else if (['memory_recall'].includes(normalizedName)) {
    summary = summarizeMemoryRecall(argsObj, resultText);
  } else {
    summary = summarizeDefault(toolName, resultText);
  }

  return truncate(summary, 200);
}
