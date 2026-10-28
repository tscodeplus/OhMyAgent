/**
 * BotIdentityRegistry — channel display names resolved from each platform.
 *
 * The registry sits between a WebUI request and a platform API: a name is cached
 * for a day but never allowed to hang or fail the request, failed lookups are
 * retried a few times and then left alone, and the last confirmed name survives a
 * restart because the interesting failure case is a machine booting while offline.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BotIdentityRegistry, type BotIdentityOptions } from '../../src/channel/bot-identity';

/** Silences the intentional warn/info lines while keeping failures readable. */
const silentLogger = () => ({ info: () => {}, warn: () => {} }) as never;

/** Tests drive attempts through resolve(); timers would only add nondeterminism. */
const manual = (options: BotIdentityOptions = {}) =>
  new BotIdentityRegistry(silentLogger(), { autoRefresh: false, ...options });

describe('BotIdentityRegistry — cache', () => {
  it('returns the name a resolver reports, and caches it for a day', async () => {
    const resolver = vi.fn(async () => 'OMA');
    const registry = manual();
    registry.register('qq', resolver);

    expect(await registry.resolve('qq')).toBe('OMA');
    expect(await registry.resolve('qq')).toBe('OMA');
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(registry.cached('qq')).toBe('OMA');
  });

  it('shares one lookup between concurrent callers', async () => {
    const resolver = vi.fn(async () => '小书');
    const registry = manual();
    registry.register('feishu', resolver);

    const names = await Promise.all([
      registry.resolve('feishu'),
      registry.resolve('feishu'),
      registry.resolve('feishu'),
    ]);

    expect(names).toEqual(['小书', '小书', '小书']);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('asks again once the cached name expires', async () => {
    let name = 'OMA';
    const registry = manual({ ttlMs: 0 });
    registry.register('qq', async () => name);

    expect(await registry.resolve('qq')).toBe('OMA');
    name = 'OMA 2';
    expect(await registry.resolve('qq')).toBe('OMA 2');
  });

  it('answers undefined for a channel nothing registered', async () => {
    expect(await manual().resolve('wechat')).toBeUndefined();
  });

  it('trims whitespace from the reported name', async () => {
    const registry = manual();
    registry.register('telegram', async () => '  my_bot  ');
    expect(await registry.resolve('telegram')).toBe('my_bot');
  });
});

describe('BotIdentityRegistry — failures', () => {
  it('keeps the last known name when a lookup throws', async () => {
    let fail = false;
    const registry = manual({ ttlMs: 0 });
    registry.register('qq', async () => {
      if (fail) throw new Error('api.sgroup.qq.com unreachable');
      return 'OMA';
    });

    expect(await registry.resolve('qq')).toBe('OMA');
    fail = true;
    // A stale label still beats a bare "QQ" in the sidebar.
    expect(await registry.resolve('qq')).toBe('OMA');
  });

  it('does not retry a failed lookup on every call', async () => {
    const resolver = vi.fn(async () => {
      throw new Error('timeout');
    });
    const registry = manual({ ttlMs: 60_000, retryMs: 60_000 });
    registry.register('qq', resolver);

    expect(await registry.resolve('qq')).toBeUndefined();
    expect(await registry.resolve('qq')).toBeUndefined();
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('gives up on a resolver that never answers', async () => {
    const registry = manual({ timeoutMs: 20 });
    registry.register('qq', () => new Promise<string>(() => {}));

    // A platform outage must cost one timeout, not a hung inbox request.
    expect(await registry.resolve('qq')).toBeUndefined();
  });

  it('gives up retrying after maxRetries failures', async () => {
    vi.useFakeTimers();
    try {
      const resolver = vi.fn(async () => {
        throw new Error('offline');
      });
      const registry = new BotIdentityRegistry(silentLogger(), {
        retryMs: 60_000,
        maxRetries: 2,
        ttlMs: 24 * 60 * 60_000,
      });
      registry.register('qq', resolver);
      await vi.advanceTimersByTimeAsync(0);
      expect(resolver).toHaveBeenCalledTimes(1); // boot attempt

      await vi.advanceTimersByTimeAsync(60_000);
      expect(resolver).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(resolver).toHaveBeenCalledTimes(3);
      // maxRetries=2 spent: no further 60 s attempts, only the daily refresh.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(resolver).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(resolver).toHaveBeenCalledTimes(4);
      registry.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops scheduling once a retry succeeds', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const resolver = vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error('dhcp not up yet');
        return 'OMA';
      });
      const registry = new BotIdentityRegistry(silentLogger(), { retryMs: 60_000 });
      registry.register('qq', resolver);
      await vi.advanceTimersByTimeAsync(0);
      expect(await registry.resolve('qq')).toBeUndefined(); // first attempt failed
      expect(registry.cached('qq')).toBeUndefined();

      // A boot-time failure is usually a network that is not up yet: one retry
      // a minute later recovers the real name.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(registry.cached('qq')).toBe('OMA');
      expect(resolver).toHaveBeenCalledTimes(2);
      registry.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores an empty name instead of caching it as a label', async () => {
    let answer = '';
    const registry = manual({ ttlMs: 60_000, retryMs: 0 });
    registry.register('feishu', async () => answer);

    expect(await registry.resolve('feishu')).toBeUndefined();
    answer = '小书';
    // Empty is "nothing to say yet", so the next call asks again rather than
    // waiting out a full TTL on a bot that simply had no name filled in.
    expect(await registry.resolve('feishu')).toBe('小书');
  });
});

describe('BotIdentityRegistry — survives an offline restart', () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-botidentity-'));
    storePath = path.join(dir, 'bot-identity.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('persists a confirmed name and serves it when the platform is unreachable', async () => {
    const first = manual({ storePath });
    first.register('qq', async () => 'OMA');
    expect(await first.resolve('qq')).toBe('OMA');
    first.dispose();

    expect(JSON.parse(fs.readFileSync(storePath, 'utf8'))).toMatchObject({
      qq: { name: 'OMA' },
    });

    // Restart with no network: the name the platform confirmed last time is the
    // one a user should still see, not a bare "QQ".
    const restarted = manual({ storePath });
    restarted.register('qq', async () => {
      throw new Error('ENOTFOUND api.sgroup.qq.com');
    });
    expect(restarted.cached('qq')).toBe('OMA');
    expect(await restarted.resolve('qq')).toBe('OMA');
  });

  it('still asks the platform on the first resolve after a restart', async () => {
    const seed = manual({ storePath });
    seed.register('qq', async () => 'OMA');
    await seed.resolve('qq');
    seed.dispose();

    const renamed = vi.fn(async () => 'OMA 改名了');
    const restarted = manual({ storePath });
    restarted.register('qq', renamed);
    // The persisted copy is a fallback, not a cache: a rename while the process
    // was down is picked up by the startup lookup.
    await vi.waitFor(() => expect(renamed).toHaveBeenCalled());
    expect(await restarted.resolve('qq')).toBe('OMA 改名了');
  });

  it('starts empty when the store is missing or corrupt', async () => {
    const missing = manual({ storePath: path.join(dir, 'nope.json') });
    missing.register('qq', async () => 'OMA');
    expect(await missing.resolve('qq')).toBe('OMA');

    fs.writeFileSync(storePath, '{ this is not json');
    const corrupt = manual({ storePath });
    corrupt.register('qq', async () => 'OMA');
    expect(await corrupt.resolve('qq')).toBe('OMA');
  });
});
