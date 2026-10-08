import { afterEach, describe, expect, it, vi } from 'vitest';
import { pollQrcodeStatus } from '../../extensions/channel-wechat/wechat-auth.js';

afterEach(() => vi.restoreAllMocks());

describe('pollQrcodeStatus cancellation', () => {
  it('forwards external aborts to the upstream request', async () => {
    let fetchSignal: AbortSignal | null | undefined;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      fetchSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        if (fetchSignal?.aborted) {
          reject(new DOMException('The operation was aborted', 'AbortError'));
          return;
        }
        fetchSignal?.addEventListener(
          'abort',
          () => reject(new DOMException('The operation was aborted', 'AbortError')),
          { once: true },
        );
      });
    });
    const controller = new AbortController();

    const pending = pollQrcodeStatus('https://ilink.example', 'qr-id', controller.signal);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSignal).toBeDefined();
    expect(fetchSignal).not.toBe(controller.signal);

    controller.abort();
    await expect(pending).resolves.toEqual({ status: 'error' });
    expect(fetchSignal?.aborted).toBe(true);
  });

  it('uses the timeout signal alongside the caller signal', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ status: 'wait' }), { status: 200 }));
    const controller = new AbortController();

    await expect(
      pollQrcodeStatus('https://ilink.example', 'qr-id', controller.signal),
    ).resolves.toEqual({ status: 'waiting' });
    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(fetchSpy.mock.calls[0]?.[1]?.signal).not.toBe(controller.signal);
  });
});
