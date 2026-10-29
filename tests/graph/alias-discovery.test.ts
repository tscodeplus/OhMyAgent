/**
 * Alias discovery (`src/graph/alias-discovery.ts`).
 *
 * The contract is precision, not coverage: only an abbreviation the memory
 * *defines* counts, because a wrong merge in the graph is unrecoverable — both
 * nodes' edges get attributed to one entity and nothing later disagrees — while a
 * missed one just leaves the duplicate that already existed.
 */

import { describe, it, expect } from 'vitest';
import { discoverAliases } from '../../src/graph/alias-discovery';

describe('discoverAliases', () => {
  it('reads a bracketed abbreviation after the full name', () => {
    const text = 'Excel 处理都用 Power Query（PQ）完成';
    expect(discoverAliases(text, 'Power Query')).toEqual(['PQ']);
  });

  it('reads the same form when the target is the abbreviation', () => {
    const text = 'Excel 处理都用 Power Query（PQ）完成';
    expect(discoverAliases(text, 'PQ')).toEqual(['Power Query']);
  });

  it('reads an introduced abbreviation', () => {
    expect(discoverAliases('Termux 又称 TX，是 Android 上的终端', 'Termux')).toEqual(['TX']);
    expect(discoverAliases('excel-mcp 简称 EMC，负责读写 Excel', 'excel-mcp')).toEqual(['EMC']);
  });

  it('reads a defined-by-abbreviation sentence', () => {
    expect(discoverAliases('PQ 是 Power Query 的简称', 'Power Query')).toEqual(['PQ']);
  });

  it('reads latin aka', () => {
    expect(discoverAliases('Power Query aka PQ handles the parsing', 'Power Query')).toEqual([
      'PQ',
    ]);
  });

  it('reads a definition glued to a Chinese sentence', () => {
    // No space before the name: the boundary is the script change, not whitespace.
    expect(discoverAliases('都用Power Query（PQ）处理', 'Power Query')).toEqual(['PQ']);
  });

  it('does not treat a shared prefix as an alias', () => {
    // The tempting heuristic, and the one that must stay out: a fork or a sibling
    // product shares a prefix and the corpus is where that distinction lives.
    expect(discoverAliases('Termux 和 Termux App 是两个不同的包', 'Termux')).toEqual([]);
  });

  it('ignores an empty pair of brackets', () => {
    expect(discoverAliases('看到 Power Query（）了', 'Power Query')).toEqual([]);
  });

  it('refuses a single character as an abbreviation', () => {
    expect(discoverAliases('Power Query（Q）', 'Power Query')).toEqual([]);
  });

  it('refuses the name itself', () => {
    expect(discoverAliases('Power Query（Power Query）', 'Power Query')).toEqual([]);
  });

  it('returns nothing when the target is not in the text', () => {
    expect(discoverAliases('Feishu（FS）是消息平台', 'Power Query')).toEqual([]);
  });

  it('is empty for empty input instead of throwing', () => {
    expect(discoverAliases('', 'Power Query')).toEqual([]);
    expect(discoverAliases('Power Query（PQ）', '')).toEqual([]);
  });
});
