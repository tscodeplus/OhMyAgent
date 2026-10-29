/**
 * `memory_recall` + structural hints.
 *
 * The graph's edges had one consumer (the WebUI) until this: recall appends the
 * relations the graph records about the memories it just returned. What matters
 * here is what the block must *not* do — it may not reorder or score results, and
 * a caller without a graph must see byte-identical output to before.
 */

import { describe, it, expect } from 'vitest';
import { createMemoryRecallTool } from '../../src/tools/builtins/memory-recall-tool';

function retrieverReturning(memories: Array<{ id: string; content: string; score: number }>) {
  return {
    retrieve: async () => memories,
    retrieveGrouped: async () => ({ memories }),
  } as never;
}

const MEMORIES = [
  { id: 'aaaaaaaa1111', content: 'excel-mcp 通过 Power Query 读取 Excel 文件', score: 0.8 },
  { id: 'bbbbbbbb2222', content: 'Termux 上装了 Node 20', score: 0.5 },
];

describe('memory_recall structural hints', () => {
  it('appends hints after the memories, with their source reference', async () => {
    const tool = createMemoryRecallTool({
      memoryRetriever: retrieverReturning(MEMORIES),
      hintsFor: () => [
        {
          subject: 'excel-mcp',
          relation: 'USES',
          object: 'Power Query',
          memoryId: 'aaaaaaaa1111',
          memoryRef: 'aaaaaaaa',
        },
      ],
    });

    const result = await tool.execute({} as never, { query: 'excel' } as never);
    const text = String((result.content as Array<{ text: string }>)[0].text);

    expect(text).toContain('excel-mcp');
    expect(text).toContain('excel-mcp —USES→ Power Query [mem:aaaaaaaa]');
    // The hint block comes after the last memory, never interleaved.
    expect(text.indexOf('Termux 上装了')).toBeLessThan(text.indexOf('—USES→'));
  });

  it('leaves the output untouched when the graph has no hints', async () => {
    const tool = createMemoryRecallTool({
      memoryRetriever: retrieverReturning(MEMORIES),
      hintsFor: () => [],
    });

    const withProvider = await tool.execute({} as never, { query: 'excel' } as never);
    const withoutProvider = await createMemoryRecallTool({
      memoryRetriever: retrieverReturning(MEMORIES),
    }).execute({} as never, { query: 'excel' } as never);

    expect((withProvider.content as Array<{ text: string }>)[0].text).toEqual(
      (withoutProvider.content as Array<{ text: string }>)[0].text,
    );
  });

  it('does not let a hint change the result order or the scores', async () => {
    const tool = createMemoryRecallTool({
      memoryRetriever: retrieverReturning(MEMORIES),
      hintsFor: () => [
        {
          subject: 'Termux',
          relation: 'DEPENDS_ON',
          object: 'Node 20',
          memoryId: 'bbbbbbbb2222',
          memoryRef: 'bbbbbbbb',
        },
      ],
    });

    const result = await tool.execute({} as never, { query: 'excel' } as never);
    const text = String((result.content as Array<{ text: string }>)[0].text);
    const memoryBlock = text.split('\n\n')[0];

    // The lower-scored memory stays second even though it is the one with a hint.
    expect(memoryBlock.indexOf('excel-mcp')).toBeLessThan(memoryBlock.indexOf('Termux'));
  });

  it('passes the retrieved memory ids to the provider', async () => {
    let seen: string[] = [];
    const tool = createMemoryRecallTool({
      memoryRetriever: retrieverReturning(MEMORIES),
      hintsFor: (ids) => {
        seen = ids;
        return [];
      },
    });

    await tool.execute({} as never, { query: 'excel' } as never);
    expect(seen).toEqual(['aaaaaaaa1111', 'bbbbbbbb2222']);
  });
});
