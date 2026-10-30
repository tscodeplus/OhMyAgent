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
      'Ubuntu 24.04→26.04 LTS 升级通道监控：截至2026-08-30，meta-release(常规)已含26.04 LTS且Supported:1，本周对比记录与升级注意事项仍保持原样，升级等待点位的具体说明留待下一轮监控更新，但meta-release 建议等待点版本。';
    // 建议 sits farther than the window from EVERY occurrence of either
    // endpoint (LTS is mentioned twice; the second mention is padded away from
    // 建议 as in the real 200+-character row).
    expect(text.indexOf('建议')).toBeGreaterThan(RELATION_EVIDENCE_WINDOW);
    expect(text.slice(text.lastIndexOf('LTS')).indexOf('建议')).toBeGreaterThan(
      RELATION_EVIDENCE_WINDOW,
    );
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

  // Endpoint-location symmetry with `directionOf` (P5 of the 2026-10-30
  // review): attestation reads EVERY occurrence of an endpoint, not just the
  // first — a memory that names X twice with the predicate near the second
  // mention states the relation, it does not lose it to the first mention's
  // distance.
  it('attests a double-mention memory whose predicate sits near the second occurrence', () => {
    // The first 电池 mention sits farther than the window from the only 调用;
    // the operative clause is the second one. The old first-occurrence-only
    // reading refused this row.
    const text =
      '电池 的旧规格是三天前记录的，等到把它们逐行核对完毕才轮到正式链路，先跑完下面这一段再说。下面这段是日志摘抄，平时不会回看。现在脚本调用 电池 API 校准，很稳。';
    expect(text.indexOf('电池')).toBe(0);
    expect(text.indexOf('调用')).toBeGreaterThan(RELATION_EVIDENCE_WINDOW);
    expect(text.lastIndexOf('电池')).toBeGreaterThan(text.indexOf('调用'));
    expect(attestsRelation(text, 'USES', '电池', 'API')).toBe(true);
  });

  it('still refuses a negated predicate near the second occurrence', () => {
    // The clause right after the SECOND 电池 mention says the relation does not
    // hold; unlike the window check, negation is read from the occurrence
    // NEAREST each endpoint — whichever of the two mentions that is.
    const text = '电池 没电了。可以先调用 API 应急。但文档明确说不要调用 电池 API 这样的组合。';
    expect(attestsRelation(text, 'USES', '电池', 'API')).toBe(false);
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
