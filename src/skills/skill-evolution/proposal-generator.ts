/**
 * Improvement Proposal Generator (P2-2)
 *
 * Analyzes low-success-rate skills and generates improvement suggestions.
 * Proposals are NEVER auto-applied — humans are always in the loop.
 *
 * Usage:
 *   const generator = new ProposalGenerator(metricsService, skillRegistry, db);
 *   const proposals = generator.generate(skillId);
 *   // → { triggerAdditions, toolAdjustments, promptRefinements }
 *
 * 持久化：传入 db 时提案写入 SQLite 的 skill_proposals 表，bootstrap 中以
 * 共享单例运行，apply/dismiss 状态跨 HTTP 请求、跨服务重启保留；不传 db
 * 时退回纯内存模式（兼容测试与旧用法）。
 */

import type Database from 'better-sqlite3';
import type { SkillMetricsService, SkillUsageStats } from './skill-metrics.js';
import type { SkillRegistry } from '../../app/types.js';
import { generateId } from '../../shared/ids.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface EvolutionProposal {
  id: string;
  skillId: string;
  type: 'trigger_addition' | 'tool_adjustment' | 'prompt_refinement' | 'general';
  title: string;
  description: string;
  /** Proposed change details */
  change: {
    field: string;
    current?: string;
    proposed: string;
    reason: string;
  };
  /** Priority: higher = more urgent */
  priority: number;
  createdAt: number;
  status: 'pending' | 'applied' | 'dismissed';
}

export interface SkillHealthReport {
  skillId: string;
  status: 'healthy' | 'warning' | 'critical';
  usageRate: number;
  successRate: number | null;
  proposals: EvolutionProposal[];
  summary: string;
}

// ── Proposal Generator ─────────────────────────────────────────────────────────

export class ProposalGenerator {
  private metrics: SkillMetricsService;
  private skillRegistry: SkillRegistry;
  /** In-memory proposal store (proposals survive until applied/dismissed) */
  private proposals = new Map<string, EvolutionProposal[]>();
  /** SQLite 持久化句柄；为 null 时退回纯内存模式 */
  private db: Database.Database | null;

  constructor(metrics: SkillMetricsService, skillRegistry: SkillRegistry, db?: Database.Database) {
    this.metrics = metrics;
    this.skillRegistry = skillRegistry;
    this.db = db ?? null;
    // 有 db 时启动即加载历史提案，保证重启后 apply/dismiss 状态可恢复
    if (this.db) {
      this.loadProposals();
    }
  }

  /**
   * 从 skill_proposals 表加载全部提案进内存（构造时调用）。
   * change_json 列反序列化回 change 字段；解析失败的行视为脏数据跳过。
   */
  private loadProposals(): void {
    const rows = this.db!.prepare('SELECT * FROM skill_proposals').all() as Array<{
      id: string;
      skill_id: string;
      type: string;
      title: string;
      description: string;
      change_json: string;
      priority: number;
      created_at: number;
      status: string;
    }>;

    for (const row of rows) {
      let change: EvolutionProposal['change'];
      try {
        change = JSON.parse(row.change_json) as EvolutionProposal['change'];
      } catch {
        continue; // 脏数据：跳过该行
      }

      const proposals = this.proposals.get(row.skill_id) ?? [];
      proposals.push({
        id: row.id,
        skillId: row.skill_id,
        type: row.type as EvolutionProposal['type'],
        title: row.title,
        description: row.description,
        change,
        priority: row.priority,
        createdAt: row.created_at,
        status: row.status as EvolutionProposal['status'],
      });
      this.proposals.set(row.skill_id, proposals);
    }
  }

  /** 将新生成的提案写入 skill_proposals 表（幂等：主键冲突时忽略） */
  private persistNewProposals(newProposals: EvolutionProposal[]): void {
    if (!this.db || newProposals.length === 0) return;

    const insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO skill_proposals
        (id, skill_id, type, title, description, change_json, priority, created_at, status)
      VALUES
        (@id, @skill_id, @type, @title, @description, @change_json, @priority, @created_at, @status)
    `);
    for (const p of newProposals) {
      insertStmt.run({
        id: p.id,
        skill_id: p.skillId,
        type: p.type,
        title: p.title,
        description: p.description,
        change_json: JSON.stringify(p.change),
        priority: p.priority,
        created_at: p.createdAt,
        status: p.status,
      });
    }
  }

  /**
   * Generate improvement proposals for a specific skill.
   */
  generate(skillId: string): EvolutionProposal[] {
    const stats = this.metrics.getStats(skillId);
    if (!stats) return [];

    const proposals: EvolutionProposal[] = [];
    const skill = this.skillRegistry.getSkillById(skillId);
    const now = Date.now();

    // ── Trigger suggestions ───────────────────────────────────────────
    if (stats.successRate !== null && stats.successRate < 60) {
      proposals.push({
        id: `prop-${generateId()}`,
        skillId,
        type: 'trigger_addition',
        title: '考虑添加更多触发词以提高匹配率',
        description: `当前成功率 ${stats.successRate}%，低成功率可能是因为用户使用了未被识别的表达方式。`,
        change: {
          field: 'triggers',
          current: skill?.manifest.triggers.join(', '),
          proposed: '添加同义词和常见变体表达（如用户最近使用的类似表达）',
          reason: `Success rate below 60% (currently ${stats.successRate}%)`,
        },
        priority: stats.successRate < 30 ? 90 : 60,
        createdAt: now,
        status: 'pending',
      });
    }

    // ── Tool suggestions ──────────────────────────────────────────────
    if (stats.topTools.length === 0 && stats.totalActivations > 5) {
      proposals.push({
        id: `prop-${generateId()}`,
        skillId,
        type: 'tool_adjustment',
        title: '考虑添加 allowed-tools 以明确技能的能力范围',
        description: '技能被激活多次但未记录到工具调用，可能还需要明确声明所需工具。',
        change: {
          field: 'allowed-tools',
          current: skill?.tools.allowedTools.join(' ') || '(none)',
          proposed: '从常见工具（如 web_search, file_read 等）中选择相关的工具声明',
          reason: 'No tool calls recorded across multiple activations',
        },
        priority: 50,
        createdAt: now,
        status: 'pending',
      });
    }

    // ── Prompt refinement suggestions ─────────────────────────────────
    if (stats.totalActivations > 10 && (!stats.avgDurationMs || stats.avgDurationMs > 120_000)) {
      proposals.push({
        id: `prop-${generateId()}`,
        skillId,
        type: 'prompt_refinement',
        title: '考虑优化技能指令以减少执行时间',
        description: `平均执行时间 ${stats.avgDurationMs ? Math.round(stats.avgDurationMs / 1000) + 's' : '未知'}，可能需要更精炼的指令或更明确的步骤。`,
        change: {
          field: 'body',
          proposed: '精简 SHOULD DO 和 WHEN 段，增加 Step-by-Step Workflow 段以提高效率',
          reason: `Average duration exceeds 2 minutes (${stats.avgDurationMs ? Math.round(stats.avgDurationMs / 1000) + 's' : 'unknown'})`,
        },
        priority: 40,
        createdAt: now,
        status: 'pending',
      });
    }

    // ── Low usage warning ─────────────────────────────────────────────
    if (stats.totalActivations <= 2 && skill) {
      proposals.push({
        id: `prop-${generateId()}`,
        skillId,
        type: 'general',
        title: '技能使用率较低',
        description: '该技能创建后很少被激活，可能需要改进触发词或重新评估其必要性。',
        change: {
          field: 'triggers',
          current: skill.manifest.triggers.join(', '),
          proposed: '考虑添加更多日常表达作为触发词',
          reason: `Only ${stats.totalActivations} activation(s) recorded`,
        },
        priority: 30,
        createdAt: now,
        status: 'pending',
      });
    }

    // Store proposals
    const existing = this.proposals.get(skillId) ?? [];
    // 只对 pending 状态的提案按 type 去重 —— dismissed/applied 的类型不再
    // 阻塞新提案生成，避免"驳回过一次就永远不再建议"的问题
    const existingTypes = new Set(
      existing.filter((p) => p.status === 'pending').map((p) => p.type),
    );
    const newProposals = proposals.filter((p) => !existingTypes.has(p.type));
    // 有 db 时持久化新提案，保证重启后仍可追溯
    this.persistNewProposals(newProposals);
    this.proposals.set(skillId, [...existing, ...newProposals]);

    return [...existing, ...newProposals];
  }

  /**
   * Get a health report for a skill.
   */
  getHealthReport(skillId: string): SkillHealthReport | null {
    const stats = this.metrics.getStats(skillId);
    if (!stats) return null;

    const proposals = this.generate(skillId);

    let status: SkillHealthReport['status'] = 'healthy';
    if (stats.successRate !== null && stats.successRate < 40) {
      status = 'critical';
    } else if (stats.successRate !== null && stats.successRate < 70) {
      status = 'warning';
    } else if (stats.totalActivations <= 2) {
      status = 'warning';
    }

    const summary = buildHealthSummary(skillId, stats, status, proposals);

    return {
      skillId,
      status,
      usageRate: stats.totalActivations,
      successRate: stats.successRate,
      proposals,
      summary,
    };
  }

  /**
   * Get global health reports for all skills.
   */
  getGlobalHealthReport(): SkillHealthReport[] {
    const globalStats = this.metrics.getGlobalStats();
    return globalStats.skills
      .map((s) => this.getHealthReport(s.skillId))
      .filter((r): r is SkillHealthReport => r !== null);
  }

  /**
   * Get pending proposals for a skill.
   */
  getProposals(skillId: string): EvolutionProposal[] {
    return this.proposals.get(skillId)?.filter((p) => p.status === 'pending') ?? [];
  }

  /**
   * Apply a proposal (mark as applied — the actual change is done by the user).
   */
  applyProposal(skillId: string, proposalId: string): boolean {
    const proposals = this.proposals.get(skillId);
    if (!proposals) return false;
    const p = proposals.find((p) => p.id === proposalId);
    if (!p) return false;
    p.status = 'applied';
    // 同步持久化状态，重启后仍保持 applied
    if (this.db) {
      this.db.prepare('UPDATE skill_proposals SET status = ? WHERE id = ?').run('applied', p.id);
    }
    return true;
  }

  /**
   * Dismiss a proposal.
   */
  dismissProposal(skillId: string, proposalId: string): boolean {
    const proposals = this.proposals.get(skillId);
    if (!proposals) return false;
    const p = proposals.find((p) => p.id === proposalId);
    if (!p) return false;
    p.status = 'dismissed';
    // 同步持久化状态，重启后仍保持 dismissed
    if (this.db) {
      this.db.prepare('UPDATE skill_proposals SET status = ? WHERE id = ?').run('dismissed', p.id);
    }
    return true;
  }
}

// ── Health Summary Builder ─────────────────────────────────────────────────────

function buildHealthSummary(
  skillId: string,
  stats: SkillUsageStats,
  status: string,
  proposals: EvolutionProposal[],
): string {
  const lines: string[] = [];
  const statusIcon = status === 'healthy' ? '✅' : status === 'warning' ? '⚠️' : '❌';

  lines.push(`${statusIcon} **${skillId}**`);
  lines.push(`  使用次数: ${stats.totalActivations}`);
  if (stats.successRate !== null) {
    lines.push(`  成功率: ${stats.successRate}%`);
  } else {
    lines.push('  成功率: (数据不足)');
  }
  if (stats.avgDurationMs) {
    lines.push(`  平均耗时: ${Math.round(stats.avgDurationMs / 1000)}s`);
  }
  lines.push(
    `  常用工具: ${
      stats.topTools
        .slice(0, 3)
        .map((t) => t.name)
        .join(', ') || '无'
    }`,
  );

  if (proposals.length > 0) {
    lines.push(`  💡 ${proposals.length} 条改进建议`);
  }

  return lines.join('\n');
}
