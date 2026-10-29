/**
 * Word order: `directionOf` in `src/graph/entity-mining.ts`.
 *
 * The gate this tests is the one the other three could not see. `attestsRelation`
 * measures distance symmetrically, so `A —USES→ B` and `B —USES→ A` score the
 * same, and `readTriple` only checks that both names occur in the quoted span.
 * Measured on 200 extraction calls: 9 edges passed every gate, 8 held up on manual
 * review, 1 had a doubtful direction — and a reversed edge is worse than noise,
 * because `closeContradictedEdges` closes the true edge with the same
 * `(subject, relation)`.
 *
 * Two properties matter more than the verdicts themselves:
 *   - `unknown` is the default, never `reversed` (unverifiable is not disproven);
 *   - a passive construction keeps its logical direction, so `被/由/受/为…所/给/
 *     是…的` may never produce `reversed` — the passive fixtures below isolate each
 *     marker rather than quoting the corpus, because Chinese puts the verb after
 *     the agent in a passive clause (which lands on `unknown` anyway, and that is
 *     the point of the case above).
 */
import { describe, expect, it } from 'vitest';
import { directionOf } from '../../src/graph/entity-mining.js';

describe('graph: edge direction', () => {
  describe('active voice', () => {
    it('reads subject, predicate, target in that order as forward', () => {
      const text = '通过 excel-mcp 使用 Power Query 获取 E:\\Excel 下所有文件的名称。';
      expect(directionOf(text, 'USES', 'excel-mcp', 'Power Query')).toBe('forward');
    });

    it('reads the same words the other way round as reversed', () => {
      const text = '通过 Power Query 使用 excel-mcp 获取 E:\\Excel 下所有文件的名称。';
      expect(directionOf(text, 'USES', 'excel-mcp', 'Power Query')).toBe('reversed');
    });

    it('matches latin endpoints and keywords regardless of case', () => {
      const text = 'EXCEL-MCP uses power query to read files';
      expect(directionOf(text, 'USES', 'excel-mcp', 'Power Query')).toBe('forward');
      expect(directionOf(text, 'USES', 'Power Query', 'excel-mcp')).toBe('reversed');
    });

    it('judges a non-USES predicate the same way', () => {
      const forward = 'Power Query 属于 Excel 的一部分';
      expect(directionOf(forward, 'PART_OF', 'Power Query', 'Excel')).toBe('forward');
      expect(directionOf(forward, 'PART_OF', 'Excel', 'Power Query')).toBe('reversed');
    });

    it('ignores a keyword that sits inside an endpoint’s own name', () => {
      // 建议 is part of 穿衣建议, so it says nothing about order. The only other
      // 建议 is 220 characters away, in another clause: unverifiable.
      const text =
        '用户询问池州今日天气情况，助手提供了池州5月29日周五的天气预报：多云，气温22-30℃，东北风微风，空气质量良，并给出穿衣建议。';
      expect(directionOf(text, 'ADVISES', '穿衣建议', '周五')).toBe('unknown');
    });
  });

  describe('passive voice keeps its logical direction', () => {
    // Recognising these as `reversed` would delete every true edge written in the
    // passive. The markers are the reviewed whitelist.
    it.each([
      ['被', '李四被建议向张三咨询'],
      ['由', '李四由建议改为张三跟进'],
      ['受', '李四受建议影响，张三跟进'],
      ['给', '李四给建议后由张三跟进'],
      ['为…所', '李四为建议所及，张三跟进'],
      ['是…的', 'Excel 是使用 Power Query 的'],
    ])('does not call a %s construction reversed', (_marker, text) => {
      const subject = text.includes('Excel') ? 'Power Query' : '张三';
      const target = text.includes('Excel') ? 'Excel' : '李四';
      expect(directionOf(text, text.includes('Excel') ? 'USES' : 'ADVISES', subject, target)).toBe(
        'forward',
      );
    });

    it('still calls the same words reversed when no passive marker is there', () => {
      // The control for every case above: the marker is what changes the verdict.
      expect(directionOf('李四建议向张三咨询', 'ADVISES', '张三', '李四')).toBe('reversed');
    });

    it('reads the English passive inside the keyword (`used by`)', () => {
      // `used by` is a USES keyword and a passive marker at the same time: the
      // surface order is target → keyword → subject, and the claim is forward.
      expect(
        directionOf('Power Query is used by excel-mcp', 'USES', 'excel-mcp', 'Power Query'),
      ).toBe('forward');
    });

    it('does not rescue a reversed pair just because a marker appears elsewhere', () => {
      // 由 and 使用 both present, but the clause that states the relation has no
      // passive construction, and the marker is on the other side of a boundary.
      const text = '数据由人工整理。通过 Power Query 使用 excel-mcp 读取文件。';
      expect(directionOf(text, 'USES', 'excel-mcp', 'Power Query')).toBe('reversed');
    });
  });

  describe('unknown is the default', () => {
    it('cannot order a relation whose vocabulary has no keyword pattern', () => {
      // `MENTIONED` asserts nothing, and a model's own relation is unverifiable
      // here — refusing it would be forbidding the vocabulary, not measuring it.
      expect(directionOf('Alice 使用 Excel', 'MENTIONED', 'Alice', 'Excel')).toBe('unknown');
      expect(directionOf('Alice 使用 Excel', 'LIKES', 'Alice', 'Excel')).toBe('unknown');
    });

    it('cannot order a pair whose endpoint the text does not spell out', () => {
      // A canonicalised name (`PQ` → `Power Query`) has no span to order.
      expect(directionOf('PQ replaced the manual ETL', 'USES', 'Power Query', 'ETL')).toBe(
        'unknown',
      );
      expect(
        directionOf('通过 excel-mcp 使用 Power Query', 'USES', 'excel-mcp', 'Power Automate'),
      ).toBe('unknown');
    });

    it('cannot order a pair the sentence never predicates over', () => {
      const text = 'Power Query 和 excel-mcp 是两回事，前者在 Excel 里，后者是个 MCP 服务。';
      expect(directionOf(text, 'USES', 'Power Query', 'excel-mcp')).toBe('unknown');
    });

    it('cannot order a pair stated both ways', () => {
      // Two clauses, one each way: picking either would be a guess, and a guess
      // that deletes is the failure this gate exists to avoid.
      const text = '通过 Power Query 使用 excel-mcp 可以，excel-mcp 使用 Power Query 也可以。';
      expect(directionOf(text, 'USES', 'excel-mcp', 'Power Query')).toBe('unknown');
    });

    it('cannot order a pair one clause states twice, both ways', () => {
      const text = 'Power Query 使用 excel-mcp，excel-mcp 使用 Power Query。';
      expect(directionOf(text, 'USES', 'excel-mcp', 'Power Query')).toBe('unknown');
    });

    it('returns unknown for empty text', () => {
      expect(directionOf('', 'USES', 'excel-mcp', 'Power Query')).toBe('unknown');
    });

    it('cannot order a shared-mention sentence (`A 和 B 都依赖 C`)', () => {
      const text = 'excel-mcp 和 Power Query 都依赖 Excel 桌面版';
      expect(directionOf(text, 'DEPENDS_ON', 'excel-mcp', 'Power Query')).toBe('unknown');
    });
  });
});
