/**
 * Serialised read-modify-write helper for `config.yaml`.
 *
 * Every writer of `config.yaml` goes through `mutateConfigYaml()` — the settings
 * form (`config-routes.ts`), agent CRUD (`config-persist.ts`), the MCP
 * install/enable/disable routes (`mcp-routes.ts`), the file browser's root
 * switch (`files-routes.ts`) and the `/permission` slash command
 * (`src/commands/command-handler.ts`). There is no unguarded read-modify-write
 * left:
 *
 * - **No lost updates**: the whole read → mutate → write cycle runs one
 *   operation at a time behind an in-process FIFO queue, so a concurrent saver
 *   cannot rewrite fields it never read. (A mutator that awaits — e.g. an MCP
 *   install that tests a connection mid-flight — is exactly the case that the
 *   previous unguarded read-modify-write lost.)
 * - **No truncated config**: the file is written to a sibling temp file and
 *   renamed into place, so a crash mid-write leaves the previous `config.yaml`
 *   intact.
 * - **Comments and formatting survive**: the round-trip uses the `yaml`
 *   package's Document API, which only a Document preserves, and keys the
 *   mutation leaves alone keep their original nodes (so a changed key loses only
 *   its own inline comment). `yaml` is already the parser `config-loader.ts`
 *   uses to read this very file, so no second YAML dependency is introduced
 *   (js-yaml, the previous writer here, simply cannot round-trip comments).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { isMap, parseDocument, type Document, type YAMLParseError } from 'yaml';
import { resetConfig } from '../config.js';

/**
 * `config.yaml` path — the resolution every writer and reader here shares
 * (`CONFIG_FILE` env override, else the process working directory).
 */
export function configFilePath(): string {
  return process.env.CONFIG_FILE || './config.yaml';
}

/**
 * Client-safe description of a YAML syntax error.
 *
 * The `yaml` package appends the offending source line plus a caret to
 * `error.message` (prettyErrors is on by default), so returning that message
 * over the API echoes a line such as `client_secret: hunter2` straight back to
 * the caller. Only the error code and the position of the fault survive.
 *
 * @param error One entry of `Document.errors`.
 * @param configPath Path to name in the message — never a secret.
 */
export function describeYamlParseError(error: YAMLParseError, configPath: string): string {
  const at = error.linePos?.[0];
  const position = at ? ` at line ${at.line}, column ${at.col}` : '';
  return `Failed to parse config file ${configPath}: not valid YAML${position} (${error.code})`;
}

/**
 * Marks the async context of an in-flight mutation. Used to detect a mutator
 * that calls `mutateConfigYaml()` again: such a call would queue behind the
 * operation that is waiting for it — a deadlock — so it is rejected instead.
 * (Anything scheduled inside a mutator inherits this context and is rejected
 * too; no config writer does that.)
 */
const mutationContext = new AsyncLocalStorage<true>();

/** Tail of the FIFO queue; always resolves, so a failed operation cannot stall it. */
let queueTail: Promise<void> = Promise.resolve();

/** Distinguishes temp files when two operations run in the same millisecond. */
let tempFileCounter = 0;

/**
 * Read `config.yaml`, hand the parsed document to `mutator`, then write it back
 * atomically. Operations are serialised process-wide: exactly one is in flight
 * at a time, in call order.
 *
 * The mutator receives a live `Document` so it can edit individual keys; use
 * `readConfigObject()` + `applyConfigObject()` for the usual "merge into the
 * parsed object" style. A mutator must not call `mutateConfigYaml()` itself —
 * that rejects with a clear error rather than deadlocking the queue.
 *
 * The returned promise rejects if the mutator, the write or the queue rejects;
 * errors are never swallowed. On success the config cache is invalidated.
 *
 * @param mutator Applied to the document while it is the only operation in
 *   flight. Its edits are what gets written.
 * @param configPath File to write, when the caller resolves the path itself
 *   (the WebUI file-browser route, whose harness may point elsewhere). Defaults
 *   to `configFilePath()`. The queue stays process-wide either way — the
 *   parameter only selects the file, it never bypasses the serialisation.
 */
export function mutateConfigYaml(
  mutator: (doc: Document) => void | Promise<void>,
  configPath?: string,
): Promise<void> {
  if (mutationContext.getStore()) {
    return Promise.reject(
      new Error(
        'mutateConfigYaml(): re-entrant call from inside a mutator would deadlock the ' +
          'serial queue. Edit the Document handed to the mutator instead of calling ' +
          'mutateConfigYaml() again.',
      ),
    );
  }

  const run = queueTail.then(() => runMutation(mutator, configPath));
  // The queue itself must survive a failed operation; the caller still sees the
  // rejection through `run`.
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Plain-object view of the document root.
 *
 * The returned object is a fresh deep copy, so a mutator may edit it freely and
 * hand it back to `applyConfigObject()`. The root is guaranteed to be a mapping
 * for documents obtained from `mutateConfigYaml()`.
 *
 * @param doc Document to read.
 */
export function readConfigObject(doc: Document): Record<string, unknown> {
  return (doc.toJS() ?? {}) as Record<string, unknown>;
}

/**
 * `config.yaml` exactly as it is on disk: no `${ENV}` interpolation, no
 * normalisation and no defaults applied. A missing file reads as `{}`.
 *
 * Throws (with a scrubbed message) when the file exists but is not valid YAML.
 * Callers use this when they must not round-trip an *effective* value — an
 * `${ENV}` placeholder has to survive a read, because writing its expansion
 * back replaces the placeholder permanently. Not part of the write queue: this
 * is a plain read.
 */
export function readRawConfigFile(): Record<string, unknown> {
  const filePath = configFilePath();
  if (!existsSync(filePath)) return {};
  const doc = parseDocument(readFileSync(filePath, 'utf-8'));
  if (doc.errors.length > 0) {
    throw new Error(describeYamlParseError(doc.errors[0], filePath));
  }
  return readConfigObject(doc);
}

/**
 * Apply `next` as the document's top level, replacing only the keys that
 * actually differ from their current value. Untouched keys keep their original
 * nodes — and therefore their comments and formatting — instead of being
 * re-serialised.
 *
 * Keys absent from `next` are removed; keys whose value is `undefined` are
 * removed too (js-yaml, the previous writer, omitted them rather than writing
 * `key: null`).
 *
 * @param doc Document to update.
 * @param next Complete desired top level, usually a mutated `readConfigObject()` result.
 */
export function applyConfigObject(doc: Document, next: Record<string, unknown>): void {
  const current = readConfigObject(doc);

  for (const [key, value] of Object.entries(next)) {
    const present = Object.prototype.hasOwnProperty.call(current, key);
    if (value === undefined) {
      if (present) doc.delete(key);
      continue;
    }
    if (present && isDeepStrictEqual(current[key], value)) continue;
    doc.set(key, value);
  }

  for (const key of Object.keys(current)) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) {
      doc.delete(key);
    }
  }
}

/** One queued read → mutate → atomic write cycle. */
async function runMutation(
  mutator: (doc: Document) => void | Promise<void>,
  configPathOverride?: string,
): Promise<void> {
  const configPath = configPathOverride ?? configFilePath();
  const raw = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';
  const doc = parseDocument(raw);

  // Unlike js-yaml's `load`, `parseDocument` collects syntax errors instead of
  // throwing; without this check a malformed file would be silently rewritten
  // as empty. The message is scrubbed: it is returned to API clients verbatim.
  if (doc.errors.length > 0) {
    throw new Error(describeYamlParseError(doc.errors[0], configPath));
  }
  if (doc.contents && !isMap(doc.contents)) {
    throw new Error(`Cannot update config file ${configPath}: root must be a YAML mapping`);
  }

  await mutationContext.run(true, () => mutator(doc));

  const text = doc.toString({ indent: 2, lineWidth: 120 });

  // Atomic write: a crash between write and rename leaves the original file
  // untouched, and rename is atomic within the same directory.
  const tmpPath = `${configPath}.${process.pid}.${++tempFileCounter}.tmp`;
  try {
    writeFileSync(tmpPath, text, 'utf-8');
    renameSync(tmpPath, configPath);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Best-effort cleanup; the write/rename error below is the one that matters.
    }
    throw err;
  }

  // The updated file invalidates the cached config (matches the writers this
  // helper replaces).
  resetConfig();
}
