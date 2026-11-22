import fs from 'fs';
import path from 'path';
import type { Logger } from 'pino';
import { parseEpochMs } from '../shared/timestamp.js';
import { MemoryRepository, Memory } from './repositories/memory-repository.js';

export interface SceneCluster {
  /** 场景标识 */
  scopeKey: string;
  /** 场景范围 */
  scope: string;
  /** 开始日期 ISO */
  startDate: string;
  /** 结束日期 ISO */
  endDate: string;
  /** 聚类包含的记忆数量 */
  memoryCount: number;
  /** 生成的 Markdown 文档内容 */
  content: string;
  /** 生成的文档文件路径（相对路径） */
  refPath: string;
}

const SKIP_KINDS = new Set(['scene']);

const KIND_NAME_MAP: Record<string, string> = {
  preference: '偏好',
  fact: '事实',
  task: '任务',
  device_state: '设备状态',
  summary: '摘要',
};

const KIND_ORDER = ['preference', 'fact', 'task', 'device_state', 'summary'];

/** `<scopeKey>_<YYYY-MM-DD>_<YYYY-MM-DD>.md` — the only file shape this class writes. */
const SCENE_FILE_PATTERN = /_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.md$/;

/**
 * Default ceiling for one scene document (256KB), mirroring TDAM v2.0.4's
 * per-scene-file limit.
 *
 * A scene file is the flattened text of every memory in its window, so its size
 * is `rows × average memory length` — unbounded in both directions. The 256KB
 * default is a *file* budget, not a truncation of any single memory: entries are
 * dropped from the tail (oldest last) and the drop count is written into the
 * document, so a reader can tell a short scene from a clipped one.
 */
export const DEFAULT_MAX_FILE_BYTES = 256 * 1024;

/** Options for one clustering pass — see {@link SceneClusterer.clusterBatch}. */
export interface SceneClusterOptions {
  /** Memory scope, default `'user'`. */
  scope?: string;
  /** Window length in days, default 7 (constructor default). */
  windowDays?: number;
  /** Windows below this memory count produce no scene, default 5. */
  minMemories?: number;
  /**
   * Cooperative cancellation, polled between scopeKeys and between the windows
   * of one scopeKey. A run stopped this way keeps everything it committed.
   */
  signal?: AbortSignal;
  /**
   * Resume point: scopeKeys at or before this one (string order) are skipped.
   * The caller owns the cursor's durability (DreamCycle stores it on its own
   * `maintenance_runs` row); an empty or missing value starts from the head.
   */
  afterScopeKey?: string;
  /** Max scopeKeys to process in this run; 0 or absent = all of them. */
  maxScopeKeys?: number;
  /**
   * Fired once a scopeKey is fully committed (files written, rows upserted,
   * stale artefacts pruned) — the natural place to persist the resume cursor.
   * A scopeKey that failed or was interrupted mid-way never fires it, so the
   * next run redoes it.
   */
  onScopeKeyDone?: (scopeKey: string) => void;
}

/** What one clustering pass did — errors included, because it does not throw. */
export interface SceneClusterRunSummary {
  /** Clusters committed by this run, in processing order. */
  clusters: SceneCluster[];
  /** scopeKeys fully processed by this run, in processing order. */
  processedScopeKeys: string[];
  /** True when this run consumed the last scopeKey — the next run starts at the head. */
  reachedEnd: boolean;
  /** Per-scopeKey failures the run continued past. */
  errors: Array<{ scopeKey: string; message: string }>;
  /** Stale scene files removed by reconciliation. */
  prunedFiles: number;
  /** Stale `scene-*` memory rows removed by reconciliation. */
  prunedMemories: number;
}

export class SceneClusterer {
  /** Per-file byte budget. `0` = unlimited (matches the `recall.maxChars*` 0 semantics). */
  private readonly maxFileBytes: number;

  constructor(
    private memoryRepo: MemoryRepository,
    private baseDir: string,
    private defaults: { windowDays?: number; minMemories?: number; maxFileBytes?: number } = {},
    private logger?: Pick<Logger, 'debug' | 'info' | 'warn'>,
  ) {
    this.maxFileBytes = defaults.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  /**
   * 对指定 scope 的记忆按 scopeKey + 时间窗口进行聚类，一次跑完全部 scopeKey。
   *
   * Thin wrapper over {@link clusterBatch} for callers that treat clustering as
   * one unit of work (maintenance job, hygiene re-cluster). It
   * rethrows when the run produced nothing *and* at least one scopeKey failed,
   * so a totally broken run still surfaces as an error while a partial run
   * returns what it committed.
   *
   * @param scope - 记忆范围，默认 'user'
   * @param windowDays - 时间窗口（天），默认 7。同一窗口内的记忆聚合为一个场景
   * @param minMemories - 最小记忆数，默认 5。低于此数量的 scopeKey 不生成场景
   */
  cluster(scope = 'user', windowDays?: number, minMemories?: number): SceneCluster[] {
    const summary = this.clusterBatch({ scope, windowDays, minMemories });
    if (summary.clusters.length === 0 && summary.errors.length > 0) {
      throw new Error(summary.errors[0].message);
    }
    return summary.clusters;
  }

  /**
   * Batched, partially-successful clustering pass.
   *
   * Three differences from the previous all-or-nothing behaviour:
   *
   * - ScopeKeys are processed in a stable (sorted) order and the run may stop
   *   after `maxScopeKeys` of them, so a backlog advances one bounded slice per
   *   night instead of needing the whole table to fit in a single phase timeout.
   *   The order has to be stable for `afterScopeKey` to mean anything: a Map's
   *   insertion order follows the rows, and rows are written between runs.
   * - Each scopeKey commits as it completes (files written atomically, rows
   *   upserted). A failure — or an abort — stops there and *keeps* the committed
   *   work. The whole-directory rollback this class used to perform was exactly
   *   wrong once runs are expected to be partial: it discarded the scopeKeys
   *   that had succeeded.
   * - Stale artefacts of a *committed* scopeKey are reconciled — scene files and
   *   `scene-*` rows the run no longer produces are deleted, so shrinking a
   *   window or merging memories no longer leaves dead links behind. ScopeKeys
   *   the run did not touch are never pruned, which is what keeps a partial run
   *   from deleting a window it simply did not reach.
   */
  clusterBatch(options: SceneClusterOptions = {}): SceneClusterRunSummary {
    const scope = options.scope ?? 'user';
    const windowDays = options.windowDays ?? this.defaults.windowDays ?? 7;
    const minMemories = options.minMemories ?? this.defaults.minMemories ?? 5;
    const maxScopeKeys = options.maxScopeKeys ?? 0;

    const summary: SceneClusterRunSummary = {
      clusters: [],
      processedScopeKeys: [],
      reachedEnd: true,
      errors: [],
      prunedFiles: 0,
      prunedMemories: 0,
    };

    // Snapshots written by the previous all-or-nothing implementation are dead
    // weight now (nothing restores from them, nothing deletes them): drop one if
    // a deployment still has it, then never create one again.
    fs.rmSync(path.join(this.baseDir, 'scenes.bak'), { recursive: true, force: true });

    // 1. 获取指定 scope 的所有记忆（排除已生成的 scene 记忆）
    const allMemories = this.memoryRepo
      .findAllByScope(scope)
      .filter((m) => !SKIP_KINDS.has(m.kind));

    // 2. 按 scopeKey 分组
    const grouped = new Map<string, Memory[]>();
    for (const mem of allMemories) {
      const list = grouped.get(mem.scope_key);
      if (list) {
        list.push(mem);
      } else {
        grouped.set(mem.scope_key, [mem]);
      }
    }

    // 3. Queue = scopeKeys that still have memories + scopeKeys that now exist
    //    only as scene artefacts. The second half is what lets a scopeKey whose
    //    memories were all deleted or merged away be reconciled instead of
    //    leaving its file and `scene-*` row behind forever: it produces no
    //    windows, so everything it owns is stale.
    const sceneScopeKeys = this.memoryRepo
      .findByScopeKind(scope, 'scene')
      .map((row) => row.scope_key);
    const queue = [...new Set([...grouped.keys(), ...sceneScopeKeys])].sort();
    const startIndex = options.afterScopeKey ? firstScopeKeyAfter(queue, options.afterScopeKey) : 0;
    const slice =
      maxScopeKeys > 0
        ? queue.slice(startIndex, startIndex + maxScopeKeys)
        : queue.slice(startIndex);
    summary.reachedEnd = startIndex + slice.length >= queue.length;

    for (const scopeKey of slice) {
      if (options.signal?.aborted) break;

      // 记忆已按 created_at ASC 排序（findAllByScope 保证）
      const written = new Set<string>();
      let committed: SceneCluster[] = [];
      try {
        committed = this.commitScopeKey(
          scopeKey,
          grouped.get(scopeKey) ?? [],
          scope,
          windowDays,
          minMemories,
          written,
          options.signal,
        );
      } catch (err) {
        // Deliberately not reconciled: this scopeKey may have written some of
        // its windows before failing, and pruning "files I did not write" would
        // delete the windows that did succeed here.
        const message = err instanceof Error ? err.message : String(err);
        summary.errors.push({ scopeKey, message });
        this.logger?.warn(
          { scopeKey, err: message },
          'Scene clustering failed for scopeKey; continuing with the next one',
        );
        continue;
      }
      // The windows this scopeKey committed are real (files written, rows
      // upserted), so they are reported either way — an abort only decides
      // whether the scopeKey counts as *complete*.
      summary.clusters.push(...committed);

      // An abort between windows leaves the scopeKey half-written in exactly the
      // same way as a failure, so it is neither reconciled nor marked as done
      // (the next run redoes it; every write here is idempotent).
      if (options.signal?.aborted) break;

      summary.prunedMemories += this.pruneStaleRows(scope, scopeKey, written);
      summary.processedScopeKeys.push(scopeKey);
      options.onScopeKeyDone?.(scopeKey);
    }

    if (summary.processedScopeKeys.length > 0 || summary.errors.length > 0) {
      if (!options.signal?.aborted) {
        // Files no active scene row references: the residue of a scopeKey whose
        // *name* is not recoverable (`safePathSegment` is lossy, so an orphan
        // cannot always be mapped back to its key) or of a write whose row
        // registration failed. Only files shaped like a scene document are
        // considered — never anything else under data/.
        summary.prunedFiles += this.pruneOrphanFiles();
      }

      this.logger?.info(
        {
          scope,
          clusterCount: summary.clusters.length,
          processedScopeKeys: summary.processedScopeKeys.length,
          windowDays,
          minMemories,
          prunedFiles: summary.prunedFiles,
          prunedMemories: summary.prunedMemories,
          errorCount: summary.errors.length,
          aborted: options.signal?.aborted === true,
        },
        'Scene clustering completed',
      );
    }

    return summary;
  }

  /**
   * Cluster and commit one scopeKey. Throws on the first write/persist failure
   * (the caller decides what a partially written scopeKey means); records the
   * refPaths it wrote into `written` so the caller can reconcile stale files.
   */
  private commitScopeKey(
    scopeKey: string,
    memories: Memory[],
    scope: string,
    windowDays: number,
    minMemories: number,
    written: Set<string>,
    signal?: AbortSignal,
  ): SceneCluster[] {
    const results: SceneCluster[] = [];
    const safeScopeKey = safePathSegment(scopeKey);

    for (const windowMemories of this.splitIntoWindows(memories, windowDays)) {
      if (signal?.aborted) break;
      if (windowMemories.length < minMemories) continue;

      const startDate = dateLabel(windowMemories[0].created_at);
      const endDate = dateLabel(windowMemories[windowMemories.length - 1].created_at);
      const refPath = `scenes/${safeScopeKey}_${startDate}_${endDate}.md`;

      const cluster: SceneCluster = {
        scopeKey,
        scope,
        startDate,
        endDate,
        memoryCount: windowMemories.length,
        content: this.generateMarkdown(scopeKey, windowMemories),
        refPath,
      };

      // 写入场景 Markdown 文件
      this.writeSceneFile(cluster);
      written.add(refPath);

      // 持久化为 scene kind 的记忆
      const sceneMemory = this.persistScene(cluster);
      this.logger?.debug(
        {
          sceneId: sceneMemory.id,
          scope,
          scopeKey,
          refPath,
          memoryCount: cluster.memoryCount,
          updatedAt: sceneMemory.updated_at,
        },
        'Scene cluster persisted',
      );

      results.push(cluster);
    }

    return results;
  }

  /**
   * Drop the `scene-*` rows of one *committed* scopeKey that this run no longer
   * produces.
   *
   * Rows are reconciled per scopeKey (a partial run only knows the truth about
   * the scopeKeys it processed); files are reconciled by one directory-wide rule
   * instead — see `pruneOrphanFiles`. Keeping them apart removes a cross-scope
   * hazard: `scenes/` is a single directory for every scope, so a file must
   * never be deleted on the strength of one scope's rows alone.
   */
  private pruneStaleRows(scope: string, scopeKey: string, written: Set<string>): number {
    let memories = 0;
    for (const row of this.memoryRepo.findByScopeAndKind(scope, scopeKey, 'scene')) {
      if (written.has(row.content)) continue;
      // Physical delete: `delete()` also drops the FTS entry, terms and vector,
      // which a soft delete would leave pointing at the removed file.
      if (this.memoryRepo.delete(row.id)) memories++;
    }
    if (memories > 0) {
      this.logger?.debug({ scopeKey, memories }, 'Scene clustering pruned stale scene rows');
    }
    return memories;
  }

  /**
   * Delete scene files no active `scene-*` row points at any more.
   *
   * The reference set spans **every scope** (`findByKind`), because `scenes/` is
   * one directory shared by all of them: filtering the rows by the scope being
   * clustered would classify the other scopes' documents as orphans and delete
   * them. Runs after the slice rather than instead of the row prune — a partial
   * run leaves the rows, and therefore the files, of the scopeKeys it skipped
   * untouched, so this can only remove genuinely unreferenced files.
   */
  private pruneOrphanFiles(): number {
    const scenesDir = path.join(this.baseDir, 'scenes');
    if (!fs.existsSync(scenesDir)) return 0;

    const referenced = new Set(this.memoryRepo.findByKind('scene').map((row) => row.content));
    let removed = 0;
    for (const entry of fs.readdirSync(scenesDir)) {
      if (!SCENE_FILE_PATTERN.test(entry)) continue;
      if (referenced.has(`scenes/${entry}`)) continue;
      try {
        fs.unlinkSync(path.join(scenesDir, entry));
        removed++;
      } catch (err) {
        this.logger?.warn(
          { file: entry, err: err instanceof Error ? err.message : String(err) },
          'Failed to remove orphaned scene file',
        );
      }
    }
    if (removed > 0) {
      this.logger?.debug({ removed }, 'Scene clustering pruned orphaned scene files');
    }
    return removed;
  }

  /**
   * 按固定时间窗口切割记忆数组。
   * 从最早记忆的日期开始，每 windowDays 天为一个窗口。
   */
  private splitIntoWindows(memories: Memory[], windowDays: number): Memory[][] {
    if (memories.length === 0) return [];

    const earliestMs = parseEpochMs(memories[0].created_at);
    const windows = new Map<number, Memory[]>();

    for (const mem of memories) {
      const memMs = parseEpochMs(mem.created_at);
      const daysSinceEarliest = Math.floor((memMs - earliestMs) / (1000 * 60 * 60 * 24));
      const windowIndex = Math.floor(daysSinceEarliest / windowDays);

      const list = windows.get(windowIndex);
      if (list) {
        list.push(mem);
      } else {
        windows.set(windowIndex, [mem]);
      }
    }

    return Array.from(windows.values());
  }

  /**
   * 生成 Markdown 场景文档内容。
   * 按 kind 分组列出记忆（preference / fact / task / device_state / summary）。
   */
  private generateMarkdown(scopeKey: string, memories: Memory[]): string {
    const sorted = [...memories].sort(
      (a, b) => parseEpochMs(a.created_at) - parseEpochMs(b.created_at),
    );

    const startDate = dateLabel(sorted[0].created_at);
    const endDate = dateLabel(sorted[sorted.length - 1].created_at);

    // 按 kind 分组
    const grouped = new Map<string, Memory[]>();
    for (const mem of sorted) {
      const list = grouped.get(mem.kind);
      if (list) {
        list.push(mem);
      } else {
        grouped.set(mem.kind, [mem]);
      }
    }

    const lines: string[] = [];
    lines.push(`# 场景: ${scopeKey}`);
    lines.push(`时间: ${startDate} ~ ${endDate}`);
    lines.push(`记忆数: ${sorted.length}`);
    lines.push('');

    // Bytes are counted as the document is built (not after the fact) so the
    // dropped-entry marker itself fits inside the budget.
    const reserve = 128;
    const fits = (extra: number) =>
      this.maxFileBytes <= 0 || usedBytes + extra <= this.maxFileBytes - reserve;
    let usedBytes = Buffer.byteLength(lines.join('\n'), 'utf-8');
    let dropped = 0;

    for (const kind of KIND_ORDER) {
      const memoriesOfKind = grouped.get(kind);
      if (!memoriesOfKind || memoriesOfKind.length === 0) continue;

      const kindName = KIND_NAME_MAP[kind] ?? kind;
      const heading = `## ${kindName}`;
      const headingBytes = Buffer.byteLength(heading + '\n', 'utf-8');
      if (!fits(headingBytes)) {
        // No room even for the heading: every entry of this kind is dropped.
        dropped += memoriesOfKind.length;
        continue;
      }
      lines.push(heading);
      usedBytes += headingBytes;

      for (let i = 0; i < memoriesOfKind.length; i++) {
        const line = `- ${memoriesOfKind[i].content}`;
        const lineBytes = Buffer.byteLength(line + '\n', 'utf-8');
        // Byte budget, not char budget: the thing being capped is the file.
        if (!fits(lineBytes)) {
          // This entry and every later one of this kind are dropped, and so is
          // everything after it (the kinds that follow would only be larger).
          dropped += memoriesOfKind.length - i;
          for (const laterKind of KIND_ORDER.slice(KIND_ORDER.indexOf(kind) + 1)) {
            dropped += grouped.get(laterKind)?.length ?? 0;
          }
          if (dropped > 0) {
            lines.push(`（已截断 ${dropped} 条：超出单文件上限 ${this.maxFileBytes} 字节）`);
          }
          return lines.join('\n');
        }
        lines.push(line);
        usedBytes += lineBytes;
      }
      lines.push('');
      usedBytes += 1;
    }

    return lines.join('\n');
  }

  /**
   * 将场景 Markdown 写入文件系统（原子写）。
   * 自动创建 scenes 子目录。
   */
  private writeSceneFile(cluster: SceneCluster): void {
    const scenesDir = path.join(this.baseDir, 'scenes');
    if (!fs.existsSync(scenesDir)) {
      fs.mkdirSync(scenesDir, { recursive: true });
    }
    const filePath = safeJoin(this.baseDir, cluster.refPath);
    // No separate "may only shrink" guard here: `generateMarkdown` already bounds
    // the content by the same ceiling, so a file that is over the limit can only
    // be rewritten smaller or equal — growing it past the ceiling is not
    // reachable through this path. (TDAM v2.0.4 needs the extra rule because its
    // scene blocks are written by more than one producer.)
    //
    // tmp + rename instead of a direct write: a throw between `writeFileSync`
    // opening the file and finishing it left a truncated scene file that nothing
    // would repair until the window was rewritten. rename() inside one directory
    // is atomic, so a reader sees the old file or the new one, never half.
    const tmpPath = `${filePath}.tmp`;
    try {
      fs.writeFileSync(tmpPath, cluster.content, 'utf-8');
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      // A failed rename must not leave the temp file behind: `.tmp` is not a
      // scene document (the orphan sweep would never touch it) and the next
      // attempt writes its own.
      fs.rmSync(tmpPath, { force: true });
      throw err;
    }
  }

  /**
   * 将场景持久化为 'scene' kind 的记忆，方便检索时使用。
   * (kind='scene', scope=原scope, scopeKey=原scopeKey, content=文件路径)
   * 使用 memoryRepo.upsert 写入（幂等）。
   */
  private persistScene(cluster: SceneCluster): Memory {
    const sceneId = `scene-${safePathSegment(cluster.scopeKey)}-${cluster.startDate}-${cluster.endDate}`;
    return this.memoryRepo.upsert({
      id: sceneId,
      scope: cluster.scope,
      scope_key: cluster.scopeKey,
      kind: 'scene',
      content: cluster.refPath,
      metadata: JSON.stringify({
        startDate: cluster.startDate,
        endDate: cluster.endDate,
        memoryCount: cluster.memoryCount,
      }),
    });
  }
}

/**
 * `created_at` 是 TEXT 列：schema 默认值写入纯数字 epoch 毫秒
 * （"1788237296000"），其前 10 个字符不是日期；应用层写入的则是 ISO 或
 * SQLite datetime 字符串（本身就以 YYYY-MM-DD 开头）。只对前者做转换，
 * 避免按时区偏移解读日期字符串导致标签跨天。
 */
function dateLabel(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  return new Date(parseEpochMs(value)).toISOString().slice(0, 10);
}

function safePathSegment(input: string): string {
  const cleaned = input.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_');
  const trimmed = cleaned.replace(/^_+|_+$/g, '');
  return trimmed || 'item';
}

/**
 * Index of the first scopeKey strictly greater than `after` in a sorted queue.
 *
 * String comparison (`>`), matching `Array.prototype.sort`'s default ordering —
 * the resume cursor is a scopeKey, so the comparison used to skip past it has to
 * agree with the ordering that produced it.
 */
function firstScopeKeyAfter(sorted: string[], after: string): number {
  const index = sorted.findIndex((key) => key > after);
  return index === -1 ? sorted.length : index;
}

function safeJoin(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, ...segments);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes scene root: ${segments.join('/')}`);
  }
  return resolvedPath;
}
