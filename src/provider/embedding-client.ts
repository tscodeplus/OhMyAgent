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
  /**
   * Retry attempts for retryable failures — HTTP 408/429/5xx and network
   * errors — with exponential backoff between attempts. Timeouts are never
   * retried (a hung provider usually stays hung, and the caller has its own
   * outer timeout). Default 2.
   */
  maxRetries?: number;
  /**
   * Base delay for the exponential backoff in ms. Delay = base * 2^attempt
   * with ±20% jitter. Default 500.
   */
  retryBaseDelayMs?: number;
}

const DEFAULT_MAX_INPUT_CHARS = 8000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;

/** HTTP statuses that are plausibly transient and worth a retry. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with ±20% jitter to avoid thundering-herd retries. */
function backoffDelay(baseMs: number, attempt: number): number {
  const exp = baseMs * 2 ** attempt;
  return Math.round(exp * (0.8 + Math.random() * 0.4));
}

export class EmbeddingClient {
  constructor(
    private config: EmbeddingClientConfig,
    private breaker: CircuitBreaker = new CircuitBreaker(),
  ) {}

  /**
   * Expose the circuit breaker for sharing with other components.
   */
  get circuitBreaker(): CircuitBreaker {
    return this.breaker;
  }

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
    const cappedTexts = texts.map((t) => this.capInput(t));

    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = this.config.maxRetries ?? DEFAULT_MAX_RETRIES;
    const baseDelay = this.config.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify({
            model: this.config.model,
            input: cappedTexts,
          }),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        // Timeouts are NOT retried — a hung provider usually stays hung, and
        // the caller's own timeout bounds the total wait.
        if (controller.signal.aborted) {
          throw new Error(`Embedding API request timed out after ${timeoutMs}ms`);
        }
        // Network error (DNS, refused, reset…) — transient, retryable.
        lastError = err;
        if (attempt < maxRetries) {
          await sleep(backoffDelay(baseDelay, attempt));
          continue;
        }
        throw err;
      }
      clearTimeout(timer);

      if (response.ok) {
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

      // Non-OK. Retry only on likely-transient statuses (rate limit, gateway
      // hiccup, overload); 4xx like 400/401 are permanent and throw at once.
      // Drain the body before backing off so the connection can be reused.
      const errorBody = await response.text().catch(() => 'unknown');
      if (attempt < maxRetries && RETRYABLE_STATUS.has(response.status)) {
        lastError = new Error(
          `Embedding API error: ${response.status} ${response.statusText} — ${errorBody}`,
        );
        await sleep(backoffDelay(baseDelay, attempt));
        continue;
      }
      throw new Error(
        `Embedding API error: ${response.status} ${response.statusText} — ${errorBody}`,
      );
    }
    // Not reached: every iteration either returns or throws.
    throw lastError ?? new Error('Embedding API request failed');
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

  /**
   * Generate embeddings for multiple texts in a single API call.
   *
   * Batching multiple texts into one request is significantly more efficient
   * than calling `embedOne()` repeatedly, as it reduces HTTP overhead and
   * allows the embedding provider to process inputs in parallel.
   *
   * When the circuit breaker is OPEN, this method throws immediately to
   * avoid wasting resources on guaranteed-to-fail requests.
   *
   * @param texts - Array of text strings to embed.
   * @returns An array of Float32Array embeddings, one per input text, in the
   *          same order as the input.
   * @throws {Error} If the circuit breaker is OPEN or the embedding API fails.
   */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    if (!this.breaker.allow()) {
      throw new Error('Circuit breaker is OPEN');
    }
    try {
      const results = await this.embed(texts);
      this.breaker.recordSuccess();
      return results;
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
