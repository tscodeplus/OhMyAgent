// ---------------------------------------------------------------------------
// QQ Bot API v2 Authentication
//
// Handles the OAuth2-style client credential flow for API access tokens
// and gateway URL discovery.
//
// Both getAccessToken() and getGatewayUrl() retry on rate-limit errors
// (HTTP 400 with err_code 40023001, or HTTP 429) with exponential backoff
// to survive deploy-time API call bursts. Backoff: 2s → 4s → 8s → 16s → 32s.
// ---------------------------------------------------------------------------

import type { Logger } from 'pino';
import type { QQAccessTokenResponse, QQGatewayUrlResponse } from './qq-types.js';

// ── Rate-limit retry config ─────────────────────────────────────────────

/** Maximum retry attempts for rate-limited requests. 5 retries ~62s total. */
const RATE_LIMIT_RETRY_MAX = 5;
/** Base delay for exponential backoff (ms). */
const RATE_LIMIT_RETRY_BASE_MS = 2_000;

/**
 * Check whether a non-2xx response from the QQ API indicates rate limiting.
 *
 * The QQ Bot API returns HTTP 400 with `err_code: 40023001` / `code: 100017`
 * when the rate limit is exceeded, rather than the standard HTTP 429.
 */
function isRateLimited(status: number, body: string): boolean {
  if (status === 429) return true;
  try {
    const parsed = JSON.parse(body);
    if (parsed.err_code === 40023001 || parsed.code === 100017) return true;
  } catch {
    // non-JSON body — not a rate limit we recognise
  }
  return false;
}

/**
 * fetch() wrapper that retries on QQ API rate-limit errors with exponential
 * backoff. Non-rate-limit errors are thrown immediately on the first attempt.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  logger: Logger,
): Promise<Response> {
  let lastBody = '';
  for (let attempt = 0; attempt < RATE_LIMIT_RETRY_MAX; attempt++) {
    const response = await fetch(url, init);
    if (response.ok) return response;

    lastBody = await response.text();
    if (!isRateLimited(response.status, lastBody)) {
      throw new Error(
        `QQ API request failed: ${response.status} ${lastBody}`,
      );
    }

    // Rate limited — retry with backoff unless this was the last attempt
    if (attempt < RATE_LIMIT_RETRY_MAX - 1) {
      const delay = RATE_LIMIT_RETRY_BASE_MS * Math.pow(2, attempt);
      logger.warn(
        { attempt: attempt + 1, delayMs: delay, status: response.status },
        'QQ API rate limited, retrying with backoff',
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw new Error(
    `QQ API rate limited after ${RATE_LIMIT_RETRY_MAX} retries: ${lastBody}`,
  );
}

export class QQAuth {
  private appId: string;
  private clientSecret: string;
  private sandbox: boolean;
  private logger: Logger;

  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;

  private gatewayUrl: string | null = null;

  private readonly AUTH_URL = 'https://bots.qq.com/app/getAppAccessToken';
  private readonly PROD_API_BASE = 'https://api.sgroup.qq.com';
  private readonly SANDBOX_API_BASE = 'https://sandbox.api.sgroup.qq.com';

  constructor(appId: string, clientSecret: string, sandbox: boolean, logger: Logger) {
    this.appId = appId;
    this.clientSecret = clientSecret;
    this.sandbox = sandbox;
    this.logger = logger.child({ module: 'qq-auth' });
  }

  /** The REST API base URL for the current environment. */
  getApiBase(): string {
    return this.sandbox ? this.SANDBOX_API_BASE : this.PROD_API_BASE;
  }

  /**
   * Obtain (or return cached) API access token.
   * Automatically refreshes when the token has fewer than 10 minutes remaining.
   */
  async getAccessToken(): Promise<string> {
    const refreshThreshold = 600_000; // 10 minutes in ms
    if (this.accessToken && this.tokenExpiresAt > Date.now() + refreshThreshold) {
      return this.accessToken;
    }

    this.logger.info('Requesting new QQ access token');

    const response = await fetchWithRetry(
      this.AUTH_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appId: this.appId,
          clientSecret: this.clientSecret,
        }),
      },
      this.logger,
    );

    const data = (await response.json()) as QQAccessTokenResponse;
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;

    this.logger.info({ expiresIn: data.expires_in }, 'QQ access token acquired');
    return this.accessToken;
  }

  /**
   * Fetch the WebSocket gateway URL from the QQ API.
   * Result is cached; call clearCache() to force a refresh.
   */
  async getGatewayUrl(): Promise<string> {
    if (this.gatewayUrl) return this.gatewayUrl;

    const token = await this.getAccessToken();
    const response = await fetchWithRetry(
      `${this.getApiBase()}/gateway`,
      { headers: { Authorization: `QQBot ${token}` } },
      this.logger,
    );

    const data = (await response.json()) as QQGatewayUrlResponse;
    this.gatewayUrl = data.url;

    this.logger.debug({ gatewayUrl: this.gatewayUrl }, 'QQ gateway URL acquired');
    return this.gatewayUrl;
  }

  /** Invalidate all cached data (token + gateway URL). */
  clearCache(): void {
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    this.gatewayUrl = null;
  }
}
