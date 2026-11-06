/**
 * The sidebar's page of chats, remembered between mounts.
 *
 * Two readers share it, with different windows: the home route uses the page the
 * bootstrap just fetched (`POST /api/projects/ensure-default`), and a re-mounted
 * tray (every drawer open on a phone) paints it instead of spinning. A short
 * window must not take the page away from the long one — that is the bug these
 * tests pin, because the eviction made every second drawer open a cold start.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  primeSessionPage,
  peekSessionPage,
  readSessionPage,
  clearSessionPage,
  SESSION_CACHE_TTL_MS,
} from '../../ui/src/utils/session-cache';
import type { SessionListPage } from '../../ui/src/types/session';

const page: SessionListPage = {
  items: [
    {
      id: 's1',
      project_id: 'p1',
      chat_id: 'webui:p1',
      title: 'first',
      created_at: 1,
      updated_at: 2,
    },
  ],
  hasMore: true,
};

describe('remembered session page', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    clearSessionPage('p1');
    vi.useRealTimers();
  });

  it('hands the page back for the project it was primed for', () => {
    primeSessionPage('p1', page);
    expect(peekSessionPage('p1')).toEqual(page);
    expect(peekSessionPage('another-project')).toBeUndefined();
  });

  it('reports the age of the page it hands back', () => {
    primeSessionPage('p1', page);
    vi.setSystemTime(new Date('2026-01-01T00:00:05Z'));

    const read = readSessionPage('p1', SESSION_CACHE_TTL_MS);
    expect(read?.ageMs).toBe(5000);
    expect(read?.page).toEqual(page);
  });

  it('closes the bootstrap window without evicting the page a re-mount needs', () => {
    primeSessionPage('p1', page);
    vi.setSystemTime(new Date('2026-01-01T00:01:01Z')); // past the 60 s handoff window

    expect(peekSessionPage('p1')).toBeUndefined();
    // Still valid for the tray, which is why a drawer open no longer spins.
    expect(readSessionPage('p1', SESSION_CACHE_TTL_MS)?.page).toEqual(page);
  });

  it('expires for good once no reader may use it', () => {
    primeSessionPage('p1', page);
    vi.setSystemTime(new Date(Date.now() + SESSION_CACHE_TTL_MS + 1000));

    expect(readSessionPage('p1', SESSION_CACHE_TTL_MS)).toBeUndefined();
    // …and it was dropped, not merely ignored.
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    expect(readSessionPage('p1', SESSION_CACHE_TTL_MS)).toBeUndefined();
  });

  it('ignores an older server that sends no page', () => {
    primeSessionPage('p1', undefined);
    expect(peekSessionPage('p1')).toBeUndefined();
  });

  it('can be forgotten', () => {
    primeSessionPage('p1', page);
    clearSessionPage('p1');
    expect(peekSessionPage('p1')).toBeUndefined();
  });
});
