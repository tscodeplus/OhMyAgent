/**
 * BotIdentityRegistry — channel display names resolved from each platform.
 *
 * The registry sits between a WebUI request and a platform API: a name is cached
 * (renames are rare) but never allowed to hang or fail the request, and a lookup
 * that fails must not be retried on the next keystroke.
 */

import { describe, it, expect, vi } from 'vitest';
import { BotIdentityRegistry } from '../../src/channel/bot-identity';

/** Silences the intentional warn/info lines while keeping failures readable. */
const silentLogger = () => ({ info: () => {}, warn: () => {} }) as never;

describe('BotIdentityRegistry', () => {
  it('returns the name a resolver reports, and caches it', async () => {
    const resolver = vi.fn(async () => 'OMA');
    const registry = new BotIdentityRegistry(silentLogger(), { ttlMs: 60_000 });
    registry.register('qq', resolver);

    expect(await registry.resolve('qq')).toBe('OMA');
    expect(await registry.resolve('qq')).toBe('OMA');
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(registry.cached('qq')).toBe('OMA');
  });

  it('asks again once the cached name expires', async () => {
    let name = 'OMA';
    const registry = new BotIdentityRegistry(silentLogger(), { ttlMs: 0 });
    registry.register('qq', async () => name);

    expect(await registry.resolve('qq')).toBe('OMA');
    name = 'OMA 2';
    expect(await registry.resolve('qq')).toBe('OMA 2');
  });

  it('shares one lookup between concurrent callers', async () => {
    const resolver = vi.fn(async () => '小书');
    const registry = new BotIdentityRegistry(silentLogger());
    registry.register('feishu', resolver);

    const names = await Promise.all([
      registry.resolve('feishu'),
      registry.resolve('feishu'),
      registry.resolve('feishu'),
    ]);

    expect(names).toEqual(['小书', '小书', '小书']);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('answers undefined for a channel nothing registered', async () => {
    const registry = new BotIdentityRegistry(silentLogger());
    expect(await registry.resolve('wechat')).toBeUndefined();
  });

  it('keeps the last known name when a lookup throws', async () => {
    let fail = false;
    const registry = new BotIdentityRegistry(silentLogger(), { ttlMs: 0 });
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
    const registry = new BotIdentityRegistry(silentLogger(), { ttlMs: 60_000, retryMs: 60_000 });
    registry.register('qq', resolver);

    expect(await registry.resolve('qq')).toBeUndefined();
    expect(await registry.resolve('qq')).toBeUndefined();
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('gives up on a resolver that never answers', async () => {
    const registry = new BotIdentityRegistry(silentLogger(), { timeoutMs: 20 });
    registry.register('qq', () => new Promise<string>(() => {}));

    // A platform outage must cost one timeout, not a hung inbox request.
    expect(await registry.resolve('qq')).toBeUndefined();
  });

  it('ignores an empty name instead of caching it as a label', async () => {
    let answer = '';
    const registry = new BotIdentityRegistry(silentLogger(), { ttlMs: 60_000, retryMs: 0 });
    registry.register('feishu', async () => answer);

    expect(await registry.resolve('feishu')).toBeUndefined();
    answer = '小书';
    // Empty is "nothing to say yet", so the next call asks again rather than
    // waiting out a full TTL on a bot that simply had no name filled in.
    expect(await registry.resolve('feishu')).toBe('小书');
  });

  it('trims whitespace from the reported name', async () => {
    const registry = new BotIdentityRegistry(silentLogger());
    registry.register('telegram', async () => '  my_bot  ');
    expect(await registry.resolve('telegram')).toBe('my_bot');
  });
});
