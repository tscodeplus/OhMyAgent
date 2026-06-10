import { describe, it, expect } from 'vitest';
import { VisionBridgeCache } from '../../src/vision-bridge/vision-bridge-cache.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('VisionBridgeCache', () => {
  it('stores and retrieves entries', () => {
    const cache = new VisionBridgeCache(10);
    cache.set('key1', 'note 1');
    cache.set('key2', 'note 2');

    expect(cache.get('key1')).toBe('note 1');
    expect(cache.get('key2')).toBe('note 2');
    expect(cache.size).toBe(2);
  });

  it('returns undefined for missing keys', () => {
    const cache = new VisionBridgeCache(10);
    expect(cache.get('nonexistent')).toBeUndefined();
  });

  it('evicts oldest entries when exceeding max size', async () => {
    const cache = new VisionBridgeCache(3);

    cache.set('a', 'note a');
    await sleep(5);
    cache.set('b', 'note b');
    await sleep(5);
    cache.set('c', 'note c');
    // Cache is now full (3 entries)

    // Access 'a' to make it recently used
    await sleep(5);
    cache.get('a');

    // Add a new entry — should evict 'b' (oldest lastUsedAt among remaining)
    await sleep(5);
    cache.set('d', 'note d');

    expect(cache.get('a')).toBe('note a'); // recently accessed, still present
    expect(cache.get('b')).toBeUndefined(); // evicted (oldest lastUsedAt)
    expect(cache.get('c')).toBe('note c');
    expect(cache.get('d')).toBe('note d');
    expect(cache.size).toBe(3);
  });

  it('clear removes all entries', () => {
    const cache = new VisionBridgeCache(10);
    cache.set('a', 'note a');
    cache.set('b', 'note b');
    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });

  it('handles single-entry cache', () => {
    const cache = new VisionBridgeCache(1);
    cache.set('a', 'note a');
    cache.set('b', 'note b');

    expect(cache.size).toBe(1);
    expect(cache.get('a')).toBeUndefined(); // evicted
    expect(cache.get('b')).toBe('note b');
  });
});
