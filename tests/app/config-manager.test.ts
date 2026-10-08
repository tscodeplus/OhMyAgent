import { describe, expect, it } from 'vitest';
import { ConfigManager } from '../../src/app/config-manager.js';
import type { AppConfig } from '../../src/app/types.js';

function config(id: string): AppConfig {
  return { id } as unknown as AppConfig;
}

describe('ConfigManager reload serialization', () => {
  it('applies overlapping reloads in invocation order', async () => {
    const manager = new ConfigManager();
    const order: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    manager.registerService('settings', {
      apply: async (next) => {
        const id = (next as unknown as { id: string }).id;
        order.push(`start:${id}`);
        if (id === 'first') {
          firstStarted();
          await firstGate;
        }
        order.push(`end:${id}`);
      },
    });

    const first = manager.reload(config('first'));
    await firstStartedPromise;
    const second = manager.reload(config('second'));

    // The second reload is queued rather than entering apply while the first
    // service is still mutating runtime configuration.
    expect(order).toEqual(['start:first']);
    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
  });

  it('continues processing queued reloads after an unexpected failure', async () => {
    const manager = new ConfigManager();
    const applied: string[] = [];
    manager.registerService('settings', {
      apply: async (next) => {
        const id = (next as unknown as { id: string }).id;
        applied.push(id);
        if (id === 'reject') throw new Error('apply failed');
      },
    });

    const rejected = await manager.reload(config('reject'));
    const recovered = await manager.reload(config('latest'));

    expect(rejected.success).toBe(false);
    expect(recovered.success).toBe(true);
    expect(applied).toEqual(['reject', 'latest']);
  });
});
