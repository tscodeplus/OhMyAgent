// ---------------------------------------------------------------------------
// QQ Bot API v2 Authentication
//
// Handles the OAuth2-style client credential flow for API access tokens
// and gateway URL discovery.
// ---------------------------------------------------------------------------

import type { Logger } from 'pino';
import type { QQAccessTokenResponse, QQGatewayUrlResponse } from './qq-types.js';

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

    const response = await fetch(this.AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: this.appId,
        clientSecret: this.clientSecret,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`QQ auth token request failed: ${response.status} ${text}`);
    }

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
    const response = await fetch(`${this.getApiBase()}/gateway`, {
      headers: { Authorization: `QQBot ${token}` },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`QQ gateway URL fetch failed: ${response.status} ${text}`);
    }

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
