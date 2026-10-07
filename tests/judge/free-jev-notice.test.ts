/**
 * Free-Jev daily privacy notice (impl doc §3.3 + §9 row 7): at most once per
 * USER (sessionId) per local day, fired only when the free tier actually
 * answers; noticed-on state persists to ledger-adjacent metadata so a restart
 * does not repeat it. Also exercises the notice-sender channel mapping.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FreeJevMonitor, isFreeJevJudgeId } from '../../src/judge/free-jev.js';
import {
  createFreeJevNoticeSender,
  mapSessionToChannel,
} from '../../src/judge/hooks/free-jev-notice.js';
import type { CronDeliveryRegistry } from '../../src/cron/delivery-registry.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'judge-free-jev-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const FREE_JUDGE_ID = 'opencode/jev-1.13-free';

describe('FreeJevMonitor — per-user-per-day notice', () => {
  it('fires once per sessionId per day; different sessions each get it', () => {
    let day = new Date('2026-01-15T09:00:00');
    const notice = vi.fn();
    const monitor = new FreeJevMonitor({ onNotice: notice, now: () => day });

    monitor.maybeNotice(FREE_JUDGE_ID, 'sess-a');
    monitor.maybeNotice(FREE_JUDGE_ID, 'sess-a'); // same day → no repeat
    monitor.maybeNotice(FREE_JUDGE_ID, 'sess-b'); // other user → fires

    expect(notice).toHaveBeenCalledTimes(2);
    expect(notice.mock.calls.map((c) => c[0] as string).sort()).toEqual(['sess-a', 'sess-b']);

    // Next day: allowed again.
    day = new Date('2026-01-16T09:00:00');
    monitor.maybeNotice(FREE_JUDGE_ID, 'sess-a');
    expect(notice).toHaveBeenCalledTimes(3);
  });

  it('only fires for the free-tier judge id', () => {
    const notice = vi.fn();
    const monitor = new FreeJevMonitor({ onNotice: notice });
    monitor.maybeNotice('opencode/jev-1.13', 'sess-a');
    expect(notice).not.toHaveBeenCalled();
    expect(isFreeJevJudgeId(FREE_JUDGE_ID)).toBe(true);
  });

  it('unanswered calls (sessionId undefined) key under "unknown" once per day', () => {
    const notice = vi.fn();
    const monitor = new FreeJevMonitor({ onNotice: notice });
    monitor.maybeNotice(FREE_JUDGE_ID);
    monitor.maybeNotice(FREE_JUDGE_ID);
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice.mock.calls[0]?.[0]).toBe('unknown');
  });

  it('async onNotice rejections are swallowed, not raised into the caller', async () => {
    const monitor = new FreeJevMonitor({
      onNotice: () => Promise.reject(new Error('delivery down')),
    });
    expect(() => monitor.maybeNotice(FREE_JUDGE_ID, 'sess-a')).not.toThrow();
  });

  it('notices-on state persists across monitor restarts (ledger metadata)', () => {
    const stateFile = join(tmpDir, 'judge-ledger', 'free-jev-notice.json');
    let day = new Date('2026-01-15T09:00:00');
    const notice = vi.fn();
    const monitor = new FreeJevMonitor({ onNotice: notice, now: () => day, stateFile });
    monitor.maybeNotice(FREE_JUDGE_ID, 'sess-a');
    // parent dir must have been created next to the ledger JSONL files
    expect(readFileSync(stateFile, 'utf8')).toContain('sess-a');

    const second = new FreeJevMonitor({ onNotice: notice, now: () => day, stateFile });
    second.maybeNotice(FREE_JUDGE_ID, 'sess-a'); // no repeat — state reloaded
    expect(notice).toHaveBeenCalledTimes(1);

    day = new Date('2026-01-16T09:00:00');
    second.maybeNotice(FREE_JUDGE_ID, 'sess-a');
    expect(notice).toHaveBeenCalledTimes(2);
  });

  it('a corrupt state file degrades to fresh state', () => {
    const stateFile = join(tmpDir, 'state.json');
    writeFileSync(stateFile, 'not-json', 'utf8');
    const notice = vi.fn();
    let day = new Date('2026-01-15T09:00:00');
    const monitor = new FreeJevMonitor({ onNotice: notice, now: () => day, stateFile });
    monitor.maybeNotice(FREE_JUDGE_ID, 'sess-a');
    expect(notice).toHaveBeenCalledTimes(1);
    // The rewrite heals the file.
    expect(() => JSON.parse(readFileSync(stateFile, 'utf8'))).not.toThrow();
  });

  it('state trimming keeps only the current day entries', () => {
    const stateFile = join(tmpDir, 'state.json');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ 'stale-sess': '2026-01-01' }), 'utf8');
    const monitor = new FreeJevMonitor({
      onNotice: () => {},
      now: () => new Date('2026-01-15T09:00:00'),
      stateFile,
    });
    monitor.maybeNotice(FREE_JUDGE_ID, 'fresh-sess');
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, string>;
    expect(parsed['stale-sess']).toBeUndefined();
    expect(parsed['fresh-sess']).toBe('2026-01-15');
  });
});

describe('mapSessionToChannel + notice sender', () => {
  it('maps every wired channel prefix', () => {
    expect(mapSessionToChannel('qq:c2c:open-x')).toEqual({ channel: 'qq', chatId: 'u:open-x' });
    expect(mapSessionToChannel('qq:group:g-x')).toEqual({ channel: 'qq', chatId: 'g:g-x' });
    expect(mapSessionToChannel('telegram:123')).toEqual({ channel: 'telegram', chatId: '123' });
    expect(mapSessionToChannel('wechat:sender-1')).toEqual({
      channel: 'wechat',
      chatId: 'sender-1',
    });
    expect(mapSessionToChannel('webui:w1')).toEqual({ channel: 'webui', chatId: 'w1' });
    expect(mapSessionToChannel('oc_abc:def')).toEqual({ channel: 'feishu', chatId: 'oc_abc' });
    expect(mapSessionToChannel('oc_abc')).toEqual({ channel: 'feishu', chatId: 'oc_abc' });
    expect(mapSessionToChannel('cron:job-1')).toBeUndefined();
    expect(mapSessionToChannel('random-session')).toBeUndefined();
  });

  it('sender uses deliverNotice when available', async () => {
    const deliverNotice = vi.fn(async () => {});
    const registry = {
      get: (channel: string) =>
        channel === 'qq' ? { deliverNotice, deliver: vi.fn() } : undefined,
    } as unknown as CronDeliveryRegistry;
    const send = createFreeJevNoticeSender({ registry });
    await send('qq:c2c:open-x');
    expect(deliverNotice).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'u:open-x', text: expect.any(String) }),
    );
  });

  it('sender falls back to deliver() without a notice method', async () => {
    const deliver = vi.fn(async () => {});
    const registry = {
      get: () => ({ deliver }),
    } as unknown as CronDeliveryRegistry;
    const send = createFreeJevNoticeSender({ registry });
    await send('telegram:123');
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: '123', modelLabel: '' }),
    );
  });

  it('delivery failures never throw into the engine', async () => {
    const registry = {
      get: () => ({
        deliverNotice: async () => {
          throw new Error('channel down');
        },
      }),
    } as unknown as CronDeliveryRegistry;
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const send = createFreeJevNoticeSender({ registry, logger });
    await expect(send('qq:c2c:x')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});
