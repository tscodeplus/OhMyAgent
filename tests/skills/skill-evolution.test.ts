/**
 * Skill Evolution tests (P1-4 / P2-2)
 *
 * Covers:
 *   - inferSatisfaction 满意度推断启发式（含"重新"误判回归）
 *   - ProposalGenerator 去重行为（dismiss 后同类型可重新生成）
 *   - ProposalGenerator SQLite 持久化（apply/dismiss 跨实例恢复）
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema.js';
import {
  SkillMetricsService,
  inferSatisfaction,
} from '../../src/skills/skill-evolution/skill-metrics.js';
import { ProposalGenerator } from '../../src/skills/skill-evolution/proposal-generator.js';
import type { SkillRegistry } from '../../src/app/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Registry stub —— getSkillById 返回 undefined 以排除 general 提案，聚焦 trigger 去重 */
function makeRegistry(): SkillRegistry {
  return {
    load: async () => {},
    resolve: () => [],
    compile: () => ({
      allowedTools: [],
      deniedTools: [],
      promptContent: '',
      memoryScopes: [],
      approvalOverrides: {},
    }),
    getSkillById: () => undefined,
    getSkills: () => [],
    isLoaded: () => true,
  };
}

/** 造出"低成功率"指标：2 次激活全部失败 → 只触发 trigger_addition 提案 */
function seedLowSuccessMetrics(db: Database.Database, skillId: string): void {
  const metrics = new SkillMetricsService(db);
  for (let i = 0; i < 2; i++) {
    const id = metrics.recordActivation(skillId, `session-${i}`, `task ${i}`);
    metrics.recordCompletion(id, 0, 1000, [{ name: 'web_search' }]);
  }
}

// ── inferSatisfaction ─────────────────────────────────────────────────────────

describe('inferSatisfaction', () => {
  it('谢谢 → satisfied (1)', () => {
    expect(inferSatisfaction('谢谢')).toBe(1);
  });

  it('不对 → unsatisfied (0)', () => {
    expect(inferSatisfaction('不对')).toBe(0);
  });

  it('正面语境中的"重新整理一下，谢谢" → satisfied (1)（回归：裸"重新"不再误判）', () => {
    expect(inferSatisfaction('重新整理一下，谢谢')).toBe(1);
    expect(inferSatisfaction('请重新整理一下谢谢')).toBe(1);
  });

  it('明确的重做请求 → unsatisfied (0)', () => {
    expect(inferSatisfaction('这个不对，重新做')).toBe(0);
    expect(inferSatisfaction('请重新弄一下')).toBe(0);
    expect(inferSatisfaction('再试一次')).toBe(0);
  });

  it('空消息 → null', () => {
    expect(inferSatisfaction(null)).toBeNull();
    expect(inferSatisfaction('')).toBeNull();
  });
});

// ── ProposalGenerator ─────────────────────────────────────────────────────────

describe('ProposalGenerator', () => {
  let db: Database.Database;
  let metrics: SkillMetricsService;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    metrics = new SkillMetricsService(db);
    seedLowSuccessMetrics(db, 'test-skill');
  });

  it('dismiss 后的提案类型可以重新生成（去重只针对 pending）', () => {
    const generator = new ProposalGenerator(metrics, makeRegistry(), db);

    const first = generator.generate('test-skill');
    expect(first).toHaveLength(1);
    expect(first[0].type).toBe('trigger_addition');

    // 驳回后再次 generate —— 同类型应重新生成（修复前：永不再生成）
    expect(generator.dismissProposal('test-skill', first[0].id)).toBe(true);
    generator.generate('test-skill');

    const pending = generator.getProposals('test-skill');
    expect(pending).toHaveLength(1);
    expect(pending[0].id).not.toBe(first[0].id);
  });

  it('pending 提案去重：同类型不重复生成', () => {
    const generator = new ProposalGenerator(metrics, makeRegistry(), db);

    generator.generate('test-skill');
    const again = generator.generate('test-skill');

    expect(again.filter((p) => p.status === 'pending')).toHaveLength(1);
  });

  it('apply/dismiss 状态持久化到 SQLite，新实例（模拟重启）可恢复', () => {
    const g1 = new ProposalGenerator(metrics, makeRegistry(), db);
    const first = g1.generate('test-skill');
    expect(first).toHaveLength(1);

    // g1 中 apply —— 同时写入 DB
    expect(g1.applyProposal('test-skill', first[0].id)).toBe(true);
    const row1 = db.prepare('SELECT status FROM skill_proposals WHERE id = ?').get(first[0].id) as {
      status: string;
    };
    expect(row1.status).toBe('applied');

    // 新实例 g2 从 DB 恢复 —— 能直接对旧提案操作即证明加载成功
    const g2 = new ProposalGenerator(metrics, makeRegistry(), db);
    expect(g2.dismissProposal('test-skill', first[0].id)).toBe(true);
    const row2 = db.prepare('SELECT status FROM skill_proposals WHERE id = ?').get(first[0].id) as {
      status: string;
    };
    expect(row2.status).toBe('dismissed');
  });

  it('无 db 时退回纯内存模式（兼容旧构造签名）', () => {
    const generator = new ProposalGenerator(metrics, makeRegistry());
    const proposals = generator.generate('test-skill');
    expect(proposals).toHaveLength(1);
    expect(generator.applyProposal('test-skill', proposals[0].id)).toBe(true);
    expect(generator.getProposals('test-skill')).toHaveLength(0);
  });
});
