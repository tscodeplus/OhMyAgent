/**
 * `[[wikilink]]` parsing and resolution.
 *
 * The invariant under test: parsing never throws and never silently drops a
 * citation that could be resolved. A target that does not exist is reported as
 * dangling; a target that exists but is not `active` must be treated exactly like
 * one that does not exist, or shadow mode leaks through the link graph.
 */

import { describe, it, expect } from 'vitest';
import { parseWikilinks, resolveWikilinks } from '../../src/memory/knowledge/links.js';

describe('parseWikilinks', () => {
  it('parses the bare and typed forms', () => {
    const links = parseWikilinks('见 [[power-query]] 与 [[topic/excel-etl]]。');
    expect(links.map((link) => ({ target: link.target, pageType: link.pageType }))).toEqual([
      { target: 'power-query', pageType: null },
      { target: 'topic/excel-etl', pageType: 'topic' },
    ]);
  });

  it('parses an Obsidian display label', () => {
    const [link] = parseWikilinks('[[topic/power-query|Power Query]]');
    expect(link).toEqual({
      target: 'topic/power-query',
      pageType: 'topic',
      slug: 'power-query',
      label: 'Power Query',
    });
  });

  it('treats an unknown prefix as part of the slug, not as a page type', () => {
    const [link] = parseWikilinks('[[notes/2024]]');
    expect(link.pageType).toBeNull();
    expect(link.slug).toBe('notes-2024');
  });

  it('normalises the slug from free-form text', () => {
    const [link] = parseWikilinks('[[Power Query]]');
    expect(link.slug).toBe('power-query');
  });

  it('deduplicates by target so one relation is written once', () => {
    const links = parseWikilinks('[[a]] [[a|later]] [[topic/a]]');
    expect(links.map((link) => link.target)).toEqual(['a', 'topic/a']);
  });

  it('ignores unaddressable and malformed links', () => {
    expect(parseWikilinks('[[🙂]]')).toEqual([]);
    expect(parseWikilinks('[[]]')).toEqual([]);
    expect(parseWikilinks('[[unclosed')).toEqual([]);
    expect(parseWikilinks('no links here')).toEqual([]);
  });

  it('keeps bold/heading noise out of the target', () => {
    // `[[**x**]]` is not a link form this parser accepts; the slug simply
    // becomes `x` after normalisation rather than failing the write.
    const [link] = parseWikilinks('[[**x**]]');
    expect(link.slug).toBe('x');
  });
});

describe('resolveWikilinks', () => {
  const lookup = new Map([
    ['topic/power-query', 'page-pq'],
    ['excel-etl', 'page-etl'],
  ]);

  it('separates resolved links from dangling ones', () => {
    const result = resolveWikilinks(
      '[[topic/power-query]] [[missing-page]] [[excel-etl]]',
      (link) => {
        return lookup.get(link.target) ?? null;
      },
    );

    expect(result.links.map((link) => link.toPageId)).toEqual(['page-pq', 'page-etl']);
    expect(result.dangling).toEqual(['missing-page']);
  });

  it('does not throw on a page full of dangling links', () => {
    const result = resolveWikilinks('[[x]] [[y]] [[z]]', () => null);
    expect(result.links).toEqual([]);
    expect(result.dangling).toEqual(['x', 'y', 'z']);
  });

  it('drops a self-link instead of recording it as a relation', () => {
    const result = resolveWikilinks('[[topic/power-query]]', () => 'page-pq', {
      selfPageId: 'page-pq',
    });
    expect(result.links).toEqual([]);
    expect(result.dangling).toEqual([]);
  });

  it('keeps the label with the resolved link', () => {
    const result = resolveWikilinks('[[topic/power-query|PQ]]', () => 'page-pq');
    expect(result.links).toEqual([
      { toPageId: 'page-pq', label: 'PQ', target: 'topic/power-query' },
    ]);
  });
});
