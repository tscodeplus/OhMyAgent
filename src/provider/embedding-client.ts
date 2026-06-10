import { CircuitBreaker } from '../memory/circuit-breaker.js';

export interface EmbeddingClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimension: number;
  /**
   * Max characters per input string sent to the embedding API. Inputs longer
   * than this are truncated before the request. Guards against provider 400s
   * on oversized text (e.g. bge-m3's ~8192-token limit). Default 8000.
   */
  maxInputChars?: number;
  /**
   * Per-request timeout in milliseconds. Without it a hung connection blocks
   * the caller indefinitely, and the circuit breaker — which only records a
   * failure when the request throws — never trips. Default 30s.
   */
  timeoutMs?: number;
}

const DEFAULT_MAX_INPUT_CHARS = 8000;
const DEFAULT_TIMEOUT_MS = 30_000;

export class EmbeddingClient {
  constructor(
    private config: EmbeddingClientConfig,
    private breaker: CircuitBreaker = new CircuitBreaker(),
  ) {}

  /**
   * Expose the circuit breaker for sharing with other components.
   */
  get circuitBreaker(): CircuitBreaker { return this.breaker; }

  /**
   * The embedding model name used by this client.
   */
  get model(): string {
    return this.config.model;
  }

  /**
   * Returns true when the embedding client has the minimum required config
   * (model + baseUrl) to make API calls. When false, callers should skip
   * vector search to avoid wasting time on guaranteed-to-fail HTTP requests.
   */
  isConfigured(): boolean {
    return !!(this.config.model && this.config.baseUrl);
  }

  /** Truncate an input string to the configured max char budget. */
  private capInput(text: string): string {
    const max = this.config.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
    return text.length > max ? text.slice(0, max) : text;
  }

  /**
   * Generate embeddings for one or more texts.
   */
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const url = this.buildUrl('/v1/embeddings');
    const cappedTexts = texts.map(t => this.capInput(t));

    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          input: cappedTexts,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`Embedding API request timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'unknown');
      throw new Error(
        `Embedding API error: ${response.status} ${response.statusText} — ${errorBody}`,
      );
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
      model: string;
    };

    // Preserve order by index
    const results = new Array<Float32Array>(texts.length);
    for (const item of data.data) {
      results[item.index] = new Float32Array(item.embedding);
    }

    return results;
  }

  /**
   * Generate embedding for a single text.
   */
  async embedOne(text: string): Promise<Float32Array> {
    if (!this.breaker.allow()) {
      throw new Error('Circuit breaker is OPEN');
    }
    try {
      const result = await this.embed([text]);
      this.breaker.recordSuccess();
      return result[0];
    } catch (e) {
      this.breaker.recordFailure();
      throw e;
    }
  }

  private buildUrl(path: string): string {
    const base = this.config.baseUrl.replace(/\/+$/, '');
    // Auto-deduplicate /v1
    if (path.startsWith('/v1') && base.endsWith('/v1')) {
      return `${base}${path.slice(3)}`;
    }
    return `${base}${path}`;
  }
}

/**
 * Create EmbeddingClient from AppConfig.
 */
export function createEmbeddingClient(
  config: {
    embedding: { baseUrl: string; apiKey: string; model: string; dimension: number };
  },
  breaker?: CircuitBreaker,
): EmbeddingClient {
  return new EmbeddingClient(config.embedding, breaker);
}
