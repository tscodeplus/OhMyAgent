import fs from 'node:fs';
import path from 'node:path';

/**
 * A single tool-execution offload record.
 *
 * Each record corresponds to one tool invocation whose full result was
 * offloaded from the LLM context into an external file.  The record
 * itself only holds a short summary (filled later by OffloadSummarizer)
 * and a `refPath` pointing to the complete result on disk.
 */
export interface OffloadRecord {
  /** Monotonically increasing sequence number within the session. */
  seq: number;
  /** Tool name, e.g. "shell", "file_read". */
  toolName: string;
  /** Tool arguments (as a plain object). */
  toolArgs: Record<string, unknown>;
  /** Relative path inside the session directory, e.g. "003-http_request.md". */
  refPath: string;
  /** Unix timestamp in milliseconds when the record was created. */
  timestamp: number;
  /** Stable identifier: "node-{seq}" zero-padded to three digits, e.g. "node-003". */
  nodeId: string;
  /** Short summary of the tool result, filled by OffloadSummarizer (initially empty). */
  summary: string;
  /** Whether the tool call succeeded or failed. */
  status: 'success' | 'error';
}

/**
 * Persistent, synchronous file-based store for offloaded tool results.
 *
 * Directory layout:
 * ```
 * {baseDir}/offload/{sessionKey}/
 * ├── offload.jsonl          # one OffloadRecord JSON per line
 * ├── 001-{toolName}.md       # full tool result wrapped in a Markdown fenced block
 * ├── 002-{toolName}.md
 * └── ...
 * ```
 *
 * All I/O is synchronous (matching the project's better-sqlite3 convention).
 */
export class OffloadStore {
  constructor(private readonly baseDir: string) {}

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private sessionDir(sessionKey: string): string {
    return safeJoin(this.baseDir, 'offload', safePathSegment(sessionKey));
  }

  /** Public accessor to session directory path, used by OffloadHygiene for size calculation. */
  getSessionDirPath(sessionKey: string): string {
    const legacyDir = trySafeJoin(this.offloadRoot(), sessionKey);
    if (legacyDir && fs.existsSync(legacyDir)) return legacyDir;
    return this.sessionDir(sessionKey);
  }

  private jsonlPath(sessionKey: string): string {
    return path.join(this.sessionDir(sessionKey), 'offload.jsonl');
  }

  private offloadRoot(): string {
    return safeJoin(this.baseDir, 'offload');
  }

  private refFilePath(sessionKey: string, refPath: string): string {
    return safeJoin(this.sessionDir(sessionKey), refPath);
  }

  /**
   * Write a tool result to disk and return its `OffloadRecord`.
   *
   * 1. Ensures the session directory exists (creates if needed).
   * 2. Writes the result content to a `{seq:03d}-{toolName}.md` file wrapped in
   *    a Markdown fenced code block.
   * 3. Appends a JSON line to `offload.jsonl`.
   * 4. Returns the newly created `OffloadRecord`.
   */
  writeToolResult(
    sessionKey: string,
    seq: number,
    toolName: string,
    args: unknown,
    result: unknown,
    isError: boolean,
    summary = '',
  ): OffloadRecord {
    const dir = this.sessionDir(sessionKey);
    fs.mkdirSync(dir, { recursive: true });

    const seqPadded = String(seq).padStart(3, '0');
    const refPath = `${seqPadded}-${safePathSegment(toolName)}.md`;
    const nodeId = `node-${seqPadded}`;
    const timestamp = Date.now();

    // Serialise result to a string for the markdown file.
    const resultStr =
      typeof result === 'string'
        ? result
        : typeof result === 'object' && result !== null
          ? JSON.stringify(result, null, 2)
          : String(result);

    const mdContent = `\`\`\`\n${resultStr}\n\`\`\`\n`;
    fs.writeFileSync(this.refFilePath(sessionKey, refPath), mdContent, 'utf-8');

    const record: OffloadRecord = {
      seq,
      toolName,
      toolArgs: (args ?? {}) as Record<string, unknown>,
      refPath,
      timestamp,
      nodeId,
      summary,
      status: isError ? 'error' : 'success',
    };

    // Append JSON line (never read the whole file, just append).
    fs.appendFileSync(this.jsonlPath(sessionKey), JSON.stringify(record) + '\n', 'utf-8');

    return record;
  }

  /**
   * Read all `OffloadRecord`s for a session from `offload.jsonl`.
   * Returns an empty array when the file does not exist (nothing offloaded yet).
   */
  getSessionRecords(sessionKey: string): OffloadRecord[] {
    const jsonlPath = this.jsonlPath(sessionKey);
    if (!fs.existsSync(jsonlPath)) {
      return [];
    }

    const raw = fs.readFileSync(jsonlPath, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    return lines.map((line) => JSON.parse(line) as OffloadRecord);
  }

  /**
   * Read the full offloaded result file for the given `refPath`.
   *
   * @throws If the referenced file does not exist.
   */
  getFullResult(sessionKey: string, refPath: string): string {
    const filePath = this.refFilePath(sessionKey, refPath);
    if (!fs.existsSync(filePath)) {
      throw new Error(
        `Offload file not found: ${refPath} (session: ${sessionKey})`,
      );
    }
    return fs.readFileSync(filePath, 'utf-8');
  }

  /**
   * Delete an entire offload session directory and all its contents.
   * Idempotent — does nothing if the directory does not exist.
   */
  deleteSession(sessionKey: string): void {
    const dirs = [this.sessionDir(sessionKey), trySafeJoin(this.offloadRoot(), sessionKey)].filter(Boolean) as string[];
    for (const dir of new Set(dirs)) {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  /**
   * Return session directory names whose last-modified time exceeds
   * `retentionDays`.
   */
  listExpiredSessions(retentionDays: number): string[] {
    const offloadDir = path.join(this.baseDir, 'offload');
    if (!fs.existsSync(offloadDir)) {
      return [];
    }

    const now = Date.now();
    const retentionMs = retentionDays * 24 * 60 * 60 * 1000;

    return fs
      .readdirSync(offloadDir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .filter((dirent) => {
        const stat = fs.statSync(path.join(offloadDir, dirent.name));
        return now - stat.mtimeMs > retentionMs;
      })
      .map((dirent) => dirent.name);
  }

  /**
   * Rough token count estimation for a list of records.
   *
   * Uses the formula: `totalJsonChars / 2.5`, which is a common rule-of-thumb
   * for estimating tokens from non-CJK text.
   */
  countTokens(records: OffloadRecord[]): number {
    const totalChars = records.reduce((sum, r) => sum + JSON.stringify(r).length, 0);
    return Math.round(totalChars / 2.5);
  }
}

function safePathSegment(input: string): string {
  const cleaned = input.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_');
  const trimmed = cleaned.replace(/^_+|_+$/g, '');
  return trimmed || 'item';
}

function safeJoin(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, ...segments);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes offload root: ${segments.join('/')}`);
  }
  return resolvedPath;
}

function trySafeJoin(root: string, ...segments: string[]): string | null {
  try {
    return safeJoin(root, ...segments);
  } catch {
    return null;
  }
}
