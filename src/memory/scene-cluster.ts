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
   * 对指定 scope 的记忆按 scopeKey + 时间窗口进行聚类。
   *
   * @param scope - 记忆范围，默认 'user'
   * @param windowDays - 时间窗口（天），默认 7。同一窗口内的记忆聚合为一个场景
   * @param minMemories - 最小记忆数，默认 5。低于此数量的 scopeKey 不生成场景
   * @returns 生成的场景列表
   */
  cluster(
    scope = 'user',
    windowDays = this.defaults.windowDays ?? 7,
    minMemories = this.defaults.minMemories ?? 5,
  ): SceneCluster[] {
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

    const results: SceneCluster[] = [];

    // Fail-soft (TDAM v0.3.6 `scene_blocks` pattern): snapshot existing scene
    // files before writing; a mid-run failure restores the snapshot instead of
    // leaving a half-written, partially-stale scenes directory.
    const backupDir = path.join(this.baseDir, 'scenes.bak');
    this.backupScenesDir(backupDir);
    try {
      this.buildClusters(grouped, scope, windowDays, minMemories, results);
    } catch (err) {
      this.restoreScenesDir(backupDir);
      this.logger?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Scene clustering failed; scene files restored from backup snapshot',
      );
      throw err instanceof Error ? err : new Error(String(err));
    }

    // A successful run must drop the snapshot: on the second and every later run
    // the backup exists (the first run has no scenes/ to copy), so leaving it
    // behind parks a full duplicate of scenes/ on disk forever — the next run
    // only replaces it. The existing backup test only exercised the first run,
    // where the backup is a no-op, which is why the leak was invisible.
    this.discardBackup(backupDir);

    if (results.length > 0) {
      this.logger?.info(
        {
          scope,
          clusterCount: results.length,
          windowDays,
          minMemories,
        },
        'Scene clustering completed',
      );
    }

    return results;
  }

  /**
   * Window/group loop extracted from cluster() so the fail-soft backup can wrap
   * file writes + memory persistence in one try/catch.
   */
  private buildClusters(
    grouped: Map<string, Memory[]>,
    scope: string,
    windowDays: number,
    minMemories: number,
    results: SceneCluster[],
  ): void {
    for (const [scopeKey, memories] of grouped) {
      // 记忆已按 created_at ASC 排序（findAllByScope 保证）
      // 按时间窗口切割
      const windows = this.splitIntoWindows(memories, windowDays);

      for (const windowMemories of windows) {
        if (windowMemories.length < minMemories) continue;

        const startDate = dateLabel(windowMemories[0].created_at);
        const endDate = dateLabel(windowMemories[windowMemories.length - 1].created_at);
        const content = this.generateMarkdown(scopeKey, windowMemories);
        const safeScopeKey = safePathSegment(scopeKey);
        const refPath = `scenes/${safeScopeKey}_${startDate}_${endDate}.md`;

        const cluster: SceneCluster = {
          scopeKey,
          scope,
          startDate,
          endDate,
          memoryCount: windowMemories.length,
          content,
          refPath,
        };

        // 写入场景 Markdown 文件
        this.writeSceneFile(cluster);

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
    }
  }

  /** Snapshot `<baseDir>/scenes` to `backupDir`. No-op when there are no scenes yet. */
  private backupScenesDir(backupDir: string): void {
    const scenesDir = path.join(this.baseDir, 'scenes');
    if (!fs.existsSync(scenesDir)) return;
    fs.rmSync(backupDir, { recursive: true, force: true });
    fs.cpSync(scenesDir, backupDir, { recursive: true });
  }

  /** Drop the snapshot after a successful run — see the call site in `cluster()`. */
  private discardBackup(backupDir: string): void {
    fs.rmSync(backupDir, { recursive: true, force: true });
  }

  /** Replace the scenes directory with the backup snapshot (idempotent). */
  private restoreScenesDir(backupDir: string): void {
    if (!fs.existsSync(backupDir)) return;
    const scenesDir = path.join(this.baseDir, 'scenes');
    fs.rmSync(scenesDir, { recursive: true, force: true });
    fs.renameSync(backupDir, scenesDir);
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
   * 将场景 Markdown 写入文件系统。
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
    fs.writeFileSync(filePath, cluster.content, 'utf-8');
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

function safeJoin(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, ...segments);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes scene root: ${segments.join('/')}`);
  }
  return resolvedPath;
}
