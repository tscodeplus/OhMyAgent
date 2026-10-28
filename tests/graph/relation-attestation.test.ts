/**
 * The projector's relation-attestation gate.
 *
 * Every case below is a row measured on the real 712-memory device database,
 * where 13 typed `memory_links` had been written by the deterministic extractor
 * that typed a relation by matching a keyword against the WHOLE memory. The
 * projector turned them into edges carrying a `source_memory_id`, which is worse
 * than the old graph: provenance made noise look authoritative.
 *
 * The fixtures are therefore verbatim corpus rows, not invented strings.
 */
import { describe, expect, it } from 'vitest';
import { attestsRelation, RELATION_EVIDENCE_WINDOW } from '../../src/graph/entity-mining.js';

describe('graph: relation attestation', () => {
  it('rejects a relation whose keyword is inside the entity’s own name', () => {
    const text =
      '用户询问池州今日天气情况，助手提供了池州5月29日周五的天气预报：多云，气温22-30℃，东北风微风，空气质量良，并给出穿衣建议。';
    // 建议 appears only inside 穿衣建议, so the memory states no such relation.
    expect(attestsRelation(text, 'ADVISES', '穿衣建议', '周五')).toBe(false);
  });

  it('rejects a relation whose keyword is in a different clause', () => {
    const text =
      'Ubuntu 24.04→26.04 LTS 升级通道监控：截至2026-08-30，meta-release(常规)已含26.04 LTS且Supported:1，但meta-release 建议等待点版本。';
    // 建议 sits far from both endpoints — 200+ characters in the real row.
    expect(text.indexOf('建议')).toBeGreaterThan(RELATION_EVIDENCE_WINDOW);
    expect(attestsRelation(text, 'ADVISES', 'LTS', '常规')).toBe(false);
  });

  it('accepts a relation whose keyword sits between the endpoints', () => {
    const text = '知识图谱向飞书建议了新的接入方式';
    expect(attestsRelation(text, 'ADVISES', '知识图谱', '飞书')).toBe(true);
  });

  it('always accepts MENTIONED — it asserts nothing', () => {
    expect(attestsRelation('anything at all', 'MENTIONED', 'a', 'b')).toBe(true);
  });

  it('accepts relation types it has no evidence rule for (unverifiable ≠ disproven)', () => {
    // Rejecting unknown relations would forbid a model from ever using its own
    // vocabulary, and would silently drop the `LIKES` rows the contradiction
    // tests depend on.
    expect(attestsRelation('Alice Smith likes Ruby', 'LIKES', 'Alice Smith', 'Ruby')).toBe(true);
  });

  it('accepts when an endpoint is not literally in the text (canonicalisation)', () => {
    // An extractor may legitimately record `PQ` for `Power Query`; there is no
    // span to measure the keyword against, so the row is unverifiable, not false.
    expect(attestsRelation('PQ replaced the manual ETL', 'ADVISES', 'Power Query', 'ETL')).toBe(
      true,
    );
  });

  it('is case- and whitespace-insensitive about the relation name', () => {
    const text = '知识图谱向飞书建议了新的接入方式';
    expect(attestsRelation(text, ' advises ', '知识图谱', '飞书')).toBe(true);
  });
});
