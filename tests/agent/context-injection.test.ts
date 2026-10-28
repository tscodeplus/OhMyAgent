/**
 * Per-turn episodic (`<recent_conversation>`, plan §6 K1-4) and knowledge
 * (`<knowledge_available>`, plan §6 K2-6) injection.
 *
 * The properties under test are the ones that decide whether these blocks are
 * safe to leave on by default:
 *
 * - **undefined provider = today's behaviour.** Both options are opt-in, so a
 *   deployment that never wires them must produce byte-identical context.
 * - **budget.** 2 items × ≤200 chars and ≤250 tokens for the episodic block,
 *   ≤2 titles and ≤150 tokens for the knowledge block — the plan's per-turn
 *   automatic-injection increment is ≤400 tokens (G4) and these two blocks are
 *   that increment.
 * - **intent gate.** The episodic block is only for a recall-shaped turn
 *   ("上次…", "we discussed…"); a turn asking for new work must not pay for it.
 * - **failure is a no-op.** A provider that throws leaves the turn exactly as
 *   it would have been, because a retrieval error is not a reason to fail.
 */

import { describe, it, expect, vi } from 'vitest';
import { createTransformContext } from '../../src/agent/context-transform.js';
import type {
  EpisodicContextItem,
  KnowledgeContextItem,
} from '../../src/agent/context-transform.js';
import { estimateTokensForText } from '../../src/shared/token-estimate.js';

/** The injected text blocks of the (single) user message. */
function textBlocks(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text as string);
}

function joined(content: unknown): string {
  return textBlocks(content).join('\n');
}

/** Number of rendered entries in a `<recent_conversation>` block. */
function episodicEntryCount(block: string): number {
  return block.split('\n').filter((line) => line.startsWith('  ') && line.includes(': ')).length;
}

const RECALL_QUERY = '上次那个 Excel 的批量替换脚本放在哪？';
const NEUTRAL_QUERY = '写一个 TypeScript 的快速排序函数，带注释';

function episodicItems(count: number): EpisodicContextItem[] {
  return Array.from({ length: count }, (_, index) => ({
    createdAt: Date.UTC(2026, 9, 8 + index),
    channel: 'feishu',
    sessionTitle: `目录检查 ${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    // Deliberately far past 200 chars: the transform, not the provider, owns the cap.
    excerpt: `第${index}条片段 `.repeat(80),
  }));
}

describe('per-turn episodic and knowledge injection', () => {
  it('leaves the turn untouched when neither provider is configured', async () => {
    const transform = createTransformContext({ maxMessages: 5, sessionKey: 'inject-off' });

    const messages = [{ role: 'user', content: RECALL_QUERY }];
    const result = await transform(messages);

    expect(result).toEqual([{ role: 'user', content: RECALL_QUERY }]);
    expect(joined(result[0]!.content)).not.toContain('<recent_conversation>');
    expect(joined(result[0]!.content)).not.toContain('<knowledge_available>');
  });

  it('injects at most 2 episodic excerpts, each within the char and token budget', async () => {
    const provider = vi.fn(() => episodicItems(3));
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'inject-episodic-budget',
      episodicContextProvider: provider,
    });

    const result = await transform([{ role: 'user', content: RECALL_QUERY }]);
    const content = result[0]!.content;
    const block = textBlocks(content).find((text) => text.includes('<recent_conversation>'))!;

    expect(provider).toHaveBeenCalledWith(RECALL_QUERY);
    expect(block).toContain('</recent_conversation>');
    expect(episodicEntryCount(block)).toBe(2);
    // Best-first: the third item is the one dropped.
    expect(block).toContain('目录检查 0');
    expect(block).not.toContain('目录检查 2');

    const excerptLines = block
      .split('\n')
      .filter((line) => line.startsWith('  ') && line.includes(': '));
    for (const line of excerptLines) {
      // "  user: " prefix + ≤200 chars of excerpt.
      expect(line.length).toBeLessThanOrEqual('  assistant: '.length + 200);
    }
    expect(estimateTokensForText(block)).toBeLessThanOrEqual(250);
  });

  it('does not inject the episodic block when the query is not about the past', async () => {
    const provider = vi.fn(() => episodicItems(2));
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'inject-episodic-gate',
      episodicContextProvider: provider,
    });

    const result = await transform([{ role: 'user', content: NEUTRAL_QUERY }]);

    expect(provider).not.toHaveBeenCalled();
    expect(joined(result[0]!.content)).not.toContain('<recent_conversation>');
  });

  it('injects at most 2 knowledge titles within the 150-token budget', async () => {
    const provider = vi.fn(
      () =>
        Array.from({ length: 3 }, (_, index) => ({
          slug: `topic/excel-etl-${index}`,
          title: `Excel ETL ${index}：用 Power Query 替代手工 VLOOKUP 的完整说明`.repeat(4),
        })) satisfies KnowledgeContextItem[],
    );
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'inject-knowledge-budget',
      knowledgeContextProvider: provider,
    });

    const result = await transform([{ role: 'user', content: NEUTRAL_QUERY }]);
    const block = textBlocks(result[0]!.content).find((text) =>
      text.includes('<knowledge_available>'),
    )!;

    expect(block).toContain('</knowledge_available>');
    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('<'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('topic/excel-etl-0 — Excel ETL 0');
    expect(lines.join('\n')).not.toContain('excel-etl-2');
    expect(estimateTokensForText(block)).toBeLessThanOrEqual(150);
  });

  it('omits a block whose provider returns nothing', async () => {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'inject-empty-providers',
      episodicContextProvider: () => [],
      knowledgeContextProvider: () => [],
    });

    const result = await transform([{ role: 'user', content: RECALL_QUERY }]);
    const text = joined(result[0]!.content);

    expect(text).not.toContain('<recent_conversation>');
    expect(text).not.toContain('<knowledge_available>');
  });

  it('keeps the turn intact when the episodic provider throws', async () => {
    const logger = { debug: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'inject-episodic-throws',
      logger,
      episodicContextProvider: () => {
        throw new Error('fts index unavailable');
      },
    });

    const result = await transform([{ role: 'user', content: RECALL_QUERY }]);

    expect(result).toEqual([{ role: 'user', content: RECALL_QUERY }]);
    expect(logger.debug).toHaveBeenCalled();
  });

  it('keeps the turn intact when the knowledge provider throws', async () => {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'inject-knowledge-throws',
      knowledgeContextProvider: () => {
        throw new Error('knowledge table missing');
      },
    });

    const result = await transform([{ role: 'user', content: NEUTRAL_QUERY }]);

    expect(result).toEqual([{ role: 'user', content: NEUTRAL_QUERY }]);
  });

  it('appends episodic, then knowledge, then persona after the user text', async () => {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'inject-block-order',
      episodicContextProvider: () => episodicItems(1),
      knowledgeContextProvider: () => [{ slug: 'topic/excel-etl', title: 'Excel ETL' }],
      personaContextProvider: () => '[用户画像]\n偏好简洁回复',
    });

    const result = await transform([{ role: 'user', content: RECALL_QUERY }]);
    const text = joined(result[0]!.content);

    expect(text.startsWith(RECALL_QUERY)).toBe(true);
    expect(text.indexOf('<recent_conversation>')).toBeGreaterThan(0);
    expect(text.indexOf('<knowledge_available>')).toBeGreaterThan(
      text.indexOf('</recent_conversation>'),
    );
    // Persona is last by design: the current preference must override any stale
    // name or fact carried by the retrieved blocks above it.
    expect(text.indexOf('<persona>')).toBeGreaterThan(text.indexOf('</knowledge_available>'));
  });

  it('keeps the combined increment of the two blocks within the 400-token plan limit', async () => {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'inject-combined-budget',
      episodicContextProvider: () => episodicItems(2),
      knowledgeContextProvider: () => [
        { slug: 'topic/excel-etl', title: 'Excel ETL：用 Power Query 替代手工 VLOOKUP' },
        { slug: 'project/ohmyagent', title: 'OhMyAgent' },
      ],
    });

    const result = await transform([{ role: 'user', content: RECALL_QUERY }]);
    const injected = textBlocks(result[0]!.content)
      .filter(
        (text) => text.includes('<recent_conversation>') || text.includes('<knowledge_available>'),
      )
      .join('\n');

    expect(estimateTokensForText(injected)).toBeLessThanOrEqual(400);
  });
});
