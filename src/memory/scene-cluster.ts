import fs from 'fs';
import path from 'path';
import type { Logger } from 'pino';
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

export class SceneClusterer {
  constructor(
    private memoryRepo: MemoryRepository,
    private baseDir: string,
    private defaults: { windowDays?: number; minMemories?: number } = {},
    private logger?: Pick<Logger, 'debug' | 'info' | 'warn'>,
  ) {}

  /**
   * 对指定 scope 的记忆按 scopeKey + 时间窗口进行聚类。
   *
   * @param scope - 记忆范围，默认 'user'
   * @param windowDays - 时间窗口（天），默认 7。同一窗口内的记忆聚合为一个场景
   * @param minMemories - 最小记忆数，默认 5。低于此数量的 scopeKey 不生成场景
   * @returns 生成的场景列表
   */
  cluster(scope = 'user', windowDays = this.defaults.windowDays ?? 7, minMemories = this.defaults.minMemories ?? 5): SceneCluster[] {
    // 1. 获取指定 scope 的所有记忆（排除已生成的 scene 记忆）
    const allMemories = this.memoryRepo
      .findAllByScope(scope)
      .filter(m => !SKIP_KINDS.has(m.kind));

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

    for (const [scopeKey, memories] of grouped) {
      // 记忆已按 created_at ASC 排序（findAllByScope 保证）
      // 按时间窗口切割
      const windows = this.splitIntoWindows(memories, windowDays);

      for (const windowMemories of windows) {
        if (windowMemories.length < minMemories) continue;

        const startDate = windowMemories[0].created_at.slice(0, 10);
        const endDate = windowMemories[windowMemories.length - 1].created_at.slice(0, 10);
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
        this.logger?.debug({
          sceneId: sceneMemory.id,
          scope,
          scopeKey,
          refPath,
          memoryCount: cluster.memoryCount,
          updatedAt: sceneMemory.updated_at,
        }, 'Scene cluster persisted');

        results.push(cluster);
      }
    }

    if (results.length > 0) {
      this.logger?.info({
        scope,
        clusterCount: results.length,
        windowDays,
        minMemories,
      }, 'Scene clustering completed');
    }

    return results;
  }

  /**
   * 按固定时间窗口切割记忆数组。
   * 从最早记忆的日期开始，每 windowDays 天为一个窗口。
   */
  private splitIntoWindows(memories: Memory[], windowDays: number): Memory[][] {
    if (memories.length === 0) return [];

    const earliest = new Date(memories[0].created_at);
    const windows = new Map<number, Memory[]>();

    for (const mem of memories) {
      const memDate = new Date(mem.created_at);
      const daysSinceEarliest = Math.floor(
        (memDate.getTime() - earliest.getTime()) / (1000 * 60 * 60 * 24),
      );
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
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );

    const startDate = sorted[0].created_at.slice(0, 10);
    const endDate = sorted[sorted.length - 1].created_at.slice(0, 10);

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

    for (const kind of KIND_ORDER) {
      const memoriesOfKind = grouped.get(kind);
      if (!memoriesOfKind || memoriesOfKind.length === 0) continue;

      const kindName = KIND_NAME_MAP[kind] ?? kind;
      lines.push(`## ${kindName}`);
      for (const mem of memoriesOfKind) {
        lines.push(`- ${mem.content}`);
      }
      lines.push('');
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
