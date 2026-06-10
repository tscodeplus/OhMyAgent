/**
 * Tool call summary formatting for streaming display.
 *
 * Converts tool name + args into a compact human-readable summary line.
 * Uses a priority-ordered key list so every tool gets a summary without
 * needing per-tool case entries. A few special rules handle multi-key
 * displays (action+target, pattern+path) and path shortening.
 *
 * Shared by all channels (Feishu, QQ, Telegram, WeChat).
 */

const SUMMARY_MAX = 80;

/**
 * Priority-ordered list of parameter keys to try when extracting a summary.
 * The first key that yields a non-empty string value is used.
 * Ordered from most-descriptive to least-descriptive.
 */
const PRIORITY_KEYS: ReadonlyArray<string> = [
  'command',
  'description',
  'query',
  'content',
  'prompt',
  'task',
  'question',
  'subject',
  'instruction',
  'file_path',
  'filePath',
  'notebook_path',
  'path',
  'url',
  'uri',
  'action',
  'title',
  'id',
  'serverId',
  'targetId',
  'jobId',
  'taskId',
  'teamId',
  'key',
  'teamName',
  'pattern',
  'name',
  'directory',
  'imagePath',
  'audioPath',
];

/** Keys whose values should be shortened with ~ for $HOME prefix. */
const PATH_KEYS = new Set([
  'file_path', 'filePath', 'notebook_path',
  'path', 'directory', 'imagePath', 'audioPath',
]);

/**
 * Build a one-line summary of a tool call for display in cards and messages.
 * e.g. "shell — echo 'import type { X } from \"./types.ts\"' ..."
 */
export function summarizeToolInput(name: string, args: unknown): string {
  if (!args || typeof args !== 'object') return '';

  const rec = args as Record<string, unknown>;

  const pick = (key: string, max = SUMMARY_MAX): string => {
    const val = rec[key];
    if (typeof val !== 'string' || !val.trim()) return '';
    const oneLine = val.replace(/\s+/g, ' ').trim();
    const result = PATH_KEYS.has(key) ? shortenPath(oneLine) : oneLine;
    return result.length > max ? result.slice(0, max) + '…' : result;
  };

  // ── Special multi-key displays (show both when available) ──

  // computer_use: "open_app Notepad" is more useful than just "open_app"
  const action = pick('action', 40);
  const target = pick('target', 40);
  if (action && target) return `${action} ${target}`;

  // grep / file_search: "pattern in path" is more useful than just "pattern"
  const pattern = pick('pattern', 40);
  const grepPath = pick('path', 30);
  if (pattern && grepPath) return `${pattern} in ${grepPath}`;

  // ── General case: first non-empty key from priority list ──

  for (const key of PRIORITY_KEYS) {
    const val = pick(key);
    if (val) return val;
  }

  // ── Fallback: any string value from the args ──

  for (const val of Object.values(rec)) {
    if (typeof val === 'string' && val.trim()) {
      const oneLine = val.replace(/\s+/g, ' ').trim();
      return oneLine.length > SUMMARY_MAX ? oneLine.slice(0, SUMMARY_MAX) + '…' : oneLine;
    }
  }

  return '';
}

function shortenPath(p: string): string {
  if (!p) return '';
  const home = process.env.HOME;
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}
