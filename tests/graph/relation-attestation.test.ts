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

  describe('technical predicates — the middle the social vocabulary could not express', () => {
    // Before these existed, a memory about tools had no relation it could
    // truthfully state, so the projector drew nodes and no edges and the graph
    // said nothing about how the toolchain fits together.

    it('attests USES when the text says the thing was used', () => {
      const text = '通过 excel-mcp 使用 Power Query 获取 E:\\Excel 下所有文件的名称和行数。';
      expect(attestsRelation(text, 'USES', 'excel-mcp', 'Power Query')).toBe(true);
    });

    it('refuses USES when the endpoints merely share a sentence', () => {
      // Both names present, no usage predicate: this is exactly the case the
      // keyword extractor used to turn into an edge.
      const text = 'Power Query 和 excel-mcp 是两回事，前者在 Excel 里，后者是个 MCP 服务。';
      expect(attestsRelation(text, 'USES', 'Power Query', 'excel-mcp')).toBe(false);
    });

    it('attests PART_OF and DEPENDS_ON from their own wording', () => {
      expect(
        attestsRelation('Power Query 属于 Excel 的一部分', 'PART_OF', 'Power Query', 'Excel'),
      ).toBe(true);
      expect(
        attestsRelation('excel-mcp 依赖 Excel 桌面版才能用', 'DEPENDS_ON', 'excel-mcp', 'Excel'),
      ).toBe(true);
    });

    it('refuses a negated predicate', () => {
      // Verbatim from the corpus: the memory says NOT to use Python, and 使用
      // sits directly before the name, which is what produced
      // `Python —USES→ excel-mcp` on the first real run.
      const text =
        '用户要求在 D:\tmp\excel-mcp 下新建 Excel 文件，并通过 excel-mcp 使用 Power Query 获取数据，明确不要使用 Python。';
      expect(attestsRelation(text, 'USES', 'Python', 'excel-mcp')).toBe(false);
      // The affirmative mention in the same sentence still attests.
      expect(attestsRelation(text, 'USES', 'excel-mcp', 'Power Query')).toBe(true);
    });

    it('only lets a negation govern its own clause', () => {
      // `不` inside a word like 不错 must not reject an unrelated relation.
      const text = '效果不错，通过 excel-mcp 使用 Power Query 完成。';
      expect(attestsRelation(text, 'USES', 'excel-mcp', 'Power Query')).toBe(true);
    });

    it('does not let one predicate attest a different one', () => {
      // 使用 is usage, not part-of: the words are close in meaning but an edge
      // labelled PART_OF would be a claim the text never made.
      const text = '通过 excel-mcp 使用 Power Query。';
      expect(attestsRelation(text, 'PART_OF', 'excel-mcp', 'Power Query')).toBe(false);
    });
  });
});
