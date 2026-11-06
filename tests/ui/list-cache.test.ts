/**
 * The sidebar's remembered pages.
 *
 * On a phone every drawer open mounts a fresh copy of the tray, which used to
 * start at `loading = true` and spin while it re-read a list it had just shown.
 * The remembered page is what makes that first paint instant; the age is what
 * tells the caller whether a silent re-read is still due. Every list on the first
 * screen shares this one store, so a second mechanism cannot drift from it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  readList,
  rememberList,
  forgetList,
  LIST_CACHE_TTL_MS,
} from '../../ui/src/utils/list-cache';

interface Page {
  items: Array<{ id: string }>;
  hasMore: boolean;
}

const page: Page = { items: [{ id: 's1' }], hasMore: true };

describe('list cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    forgetList('inbox');
    forgetList('archive');
    vi.useRealTimers();
  });

  it('has nothing to seed on a cold start', () => {
    expect(readList('inbox')).toBeUndefined();
  });

  it('hands back the remembered page with its age', () => {
    rememberList('inbox', page);
    vi.setSystemTime(new Date('2026-01-01T00:00:20Z'));

    const read = readList<Page>('inbox');
    expect(read?.data).toEqual(page);
    expect(read?.ageMs).toBe(20_000);
  });

  it('keeps keys apart', () => {
    rememberList('inbox', page);
    expect(readList<Page>('archive')).toBeUndefined();
    expect(readList<Page>('inbox')?.data).toEqual(page);
  });

  it('does not let a short-window reader evict a longer one', () => {
    rememberList('inbox', page);
    vi.setSystemTime(new Date('2026-01-01T00:01:01Z')); // past a 60 s window

    expect(readList('inbox', 60_000)).toBeUndefined();
    // Still valid for the tray, which is why a drawer open no longer spins.
    expect(readList<Page>('inbox')?.data).toEqual(page);
  });

  it('expires for good once no reader may use it', () => {
    rememberList('inbox', page);
    vi.setSystemTime(new Date(Date.now() + LIST_CACHE_TTL_MS + 1000));

    expect(readList('inbox')).toBeUndefined();
    // …and it was dropped, not merely ignored.
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    expect(readList('inbox')).toBeUndefined();
  });

  it('can be forgotten explicitly', () => {
    rememberList('inbox', page);
    forgetList('inbox');
    expect(readList('inbox')).toBeUndefined();

    // `remember(undefined)` is the same gesture.
    rememberList('archive', page);
    rememberList('archive', undefined);
    expect(readList('archive')).toBeUndefined();
  });
});
