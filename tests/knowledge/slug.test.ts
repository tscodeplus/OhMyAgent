/**
 * Slug derivation.
 *
 * A page's identity is `(page_type, slug)`, and slugs are addressed by
 * `[[wikilinks]]`, so the two properties that matter are: the same title always
 * yields the same slug, and a Chinese title stays readable instead of collapsing
 * to a hash or to nothing.
 */

import { describe, it, expect } from 'vitest';
import { nextFreeSlug, slugify } from '../../src/memory/knowledge/slug.js';

describe('slugify', () => {
  it('lowercases and hyphenates an English title', () => {
    expect(slugify('Power Query')).toBe('power-query');
    expect(slugify('  Excel   ETL  ')).toBe('excel-etl');
  });

  it('keeps Chinese characters so the slug stays readable', () => {
    expect(slugify('知识图谱')).toBe('知识图谱');
    expect(slugify('记忆系统设计')).toBe('记忆系统设计');
  });

  it('handles a mixed zh/en title in one pass', () => {
    expect(slugify('Excel ETL：用 Power Query 替代 VLOOKUP')).toBe(
      'excel-etl-用-power-query-替代-vlookup',
    );
  });

  it('folds full-width characters (NFKC) so an IME title is not lost', () => {
    expect(slugify('ＰＱ')).toBe('pq');
    expect(slugify('１２３')).toBe('123');
  });

  it('never carries path or markup meaning', () => {
    expect(slugify('../etc/passwd')).toBe('etc-passwd');
    expect(slugify('a[[b]]c')).toBe('a-b-c');
    expect(slugify('topic/power-query')).toBe('topic-power-query');
  });

  it('returns an empty slug when there is nothing addressable', () => {
    expect(slugify('!!!')).toBe('');
    expect(slugify('🙂🙂')).toBe('');
    expect(slugify('   ')).toBe('');
  });

  it('truncates without leaving a trailing separator', () => {
    const slug = slugify('alpha beta gamma delta', 12);
    expect(slug.length).toBeLessThanOrEqual(12);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('nextFreeSlug', () => {
  it('returns the base when it is free', () => {
    expect(nextFreeSlug('excel-etl', () => false)).toBe('excel-etl');
  });

  it('suffixes collisions in order', () => {
    const taken = new Set(['excel-etl', 'excel-etl-2']);
    const slug = nextFreeSlug('excel-etl', (candidate) => taken.has(candidate));
    expect(slug).toBe('excel-etl-3');
  });

  it('substitutes a stem when the base is empty', () => {
    expect(nextFreeSlug('', () => false)).toBe('page');
    const taken = new Set(['page']);
    expect(nextFreeSlug('', (candidate) => taken.has(candidate))).toBe('page-2');
  });
});
