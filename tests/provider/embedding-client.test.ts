import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmbeddingClient, createEmbeddingClient } from '../../src/provider/embedding-client';

describe('EmbeddingClient', () => {
  const config = {
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'test-embed',
    dimension: 128,
  };

  describe('buildUrl', () => {
    it('builds URL normally when base does not end with /v1', () => {
      const client = new EmbeddingClient({
        ...config,
        baseUrl: 'https://api.example.com',
      });
      // Access private buildUrl via embed to verify (indirect test)
      // Instead, test the public contract
      expect(client).toBeDefined();
    });

    it('deduplicates /v1 when base already ends with /v1', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: [1, 2, 3], index: 0 }],
          model: 'test-embed',
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const client = new EmbeddingClient({
        ...config,
        baseUrl: 'https://api.example.com/v1',
      });
      await client.embed(['hello']);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/v1/embeddings',
        expect.anything(),
      );

      vi.unstubAllGlobals();
    });

    it('appends /v1/embeddings when base does not end with /v1', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: [1, 2, 3], index: 0 }],
          model: 'test-embed',
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const client = new EmbeddingClient({
        ...config,
        baseUrl: 'https://api.example.com',
      });
      await client.embed(['hello']);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/v1/embeddings',
        expect.anything(),
      );

      vi.unstubAllGlobals();
    });
  });

  describe('embed', () => {
    beforeEach(() => {
      vi.unstubAllGlobals();
    });

    it('returns empty array for empty input', async () => {
      const client = new EmbeddingClient(config);
      const result = await client.embed([]);
      expect(result).toEqual([]);
    });

    it('returns Float32Array[] from API response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { embedding: [1, 2, 3], index: 1 },
            { embedding: [4, 5, 6], index: 0 },
          ],
          model: 'test-embed',
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const client = new EmbeddingClient(config);
      const results = await client.embed(['world', 'hello']);

      expect(results).toHaveLength(2);
      // index 0 should be [4, 5, 6], index 1 should be [1, 2, 3]
      expect(results[0]).toBeInstanceOf(Float32Array);
      expect(Array.from(results[0])).toEqual([4, 5, 6]);
      expect(Array.from(results[1])).toEqual([1, 2, 3]);
    });

    it('throws on non-ok response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => 'invalid key',
      });
      vi.stubGlobal('fetch', mockFetch);

      const client = new EmbeddingClient(config);
      await expect(client.embed(['hello'])).rejects.toThrow('Embedding API error: 401 Unauthorized');
    });

    it('aborts and throws when the request exceeds timeoutMs', async () => {
      // Simulate a hung connection: fetch settles only when the abort fires.
      const mockFetch = vi.fn().mockImplementation((_url: string, opts: any) => {
        return new Promise((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            (err as any).name = 'AbortError';
            reject(err);
          });
        });
      });
      vi.stubGlobal('fetch', mockFetch);

      const client = new EmbeddingClient({ ...config, timeoutMs: 20 });
      await expect(client.embed(['hello'])).rejects.toThrow(/timed out after 20ms/);
    });
  });

  describe('embedOne', () => {
    beforeEach(() => {
      vi.unstubAllGlobals();
    });

    it('returns single Float32Array', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: [10, 20, 30], index: 0 }],
          model: 'test-embed',
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const client = new EmbeddingClient(config);
      const result = await client.embedOne('hello');

      expect(result).toBeInstanceOf(Float32Array);
      expect(Array.from(result)).toEqual([10, 20, 30]);
    });
  });

  describe('maxInputChars', () => {
    beforeEach(() => {
      vi.unstubAllGlobals();
    });

    function mockOnce() {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: [1, 2, 3], index: 0 }], model: 'test-embed' }),
      });
      vi.stubGlobal('fetch', mockFetch);
      return mockFetch;
    }

    function sentInputs(mockFetch: ReturnType<typeof vi.fn>): string[] {
      return JSON.parse((mockFetch.mock.calls[0][1] as any).body).input;
    }

    it('truncates oversized input to the configured limit before sending', async () => {
      const mockFetch = mockOnce();
      const client = new EmbeddingClient({ ...config, maxInputChars: 100 });
      await client.embed(['x'.repeat(5000)]);
      expect(sentInputs(mockFetch)[0]).toHaveLength(100);
      vi.unstubAllGlobals();
    });

    it('defaults to an 8000-char cap when unset', async () => {
      const mockFetch = mockOnce();
      const client = new EmbeddingClient(config);
      await client.embed(['y'.repeat(40000)]);
      expect(sentInputs(mockFetch)[0]).toHaveLength(8000);
      vi.unstubAllGlobals();
    });

    it('leaves short input unchanged', async () => {
      const mockFetch = mockOnce();
      const client = new EmbeddingClient({ ...config, maxInputChars: 100 });
      await client.embed(['short text']);
      expect(sentInputs(mockFetch)[0]).toBe('short text');
      vi.unstubAllGlobals();
    });
  });
});

describe('createEmbeddingClient', () => {
  it('creates EmbeddingClient from config', () => {
    const client = createEmbeddingClient({
      embedding: {
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test',
        model: 'test-model',
        dimension: 128,
      },
    });
    expect(client).toBeInstanceOf(EmbeddingClient);
  });
});
