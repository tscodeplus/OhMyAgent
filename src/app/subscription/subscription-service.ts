/**
 * Subscription Service — manages OAuth credentials for AI providers.
 *
 * Credentials are stored in auth.json under the configured data directory
 * (same directory as app.db). This file is shared between the CLI and the
 * HTTP server so that credentials obtained via either interface are
 * immediately available to the other.
 *
 * Supported providers (built into pi-mono):
 *   - anthropic       (Claude Pro/Max — PKCE flow)
 *   - github-copilot  (GitHub Copilot — Device Code flow)
 *   - openai-codex    (ChatGPT Plus/Pro — PKCE + Device Code flows)
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  getOAuthProvider,
  getOAuthProviders,
  getOAuthApiKey,
} from '../../pi-mono/ai/utils/oauth/index.js';
import type {
  OAuthCredentials,
  OAuthProviderInterface,
  OAuthLoginCallbacks,
} from '../../pi-mono/ai/utils/oauth/types.js';
import type { AppConfig } from '../types.js';

// ─── Types ───

export interface SubscriptionStatus {
  providerId: string;
  providerName: string;
  loggedIn: boolean;
  expiresAt: number | null;
  accountInfo?: Record<string, unknown>;
}

/** Events emitted during login, delivered via WebSocket channel "subscription:{providerId}". */
export interface SubscriptionProgressEvent {
  type: 'auth_url' | 'device_code' | 'progress' | 'prompt' | 'select' | 'manual_code_input' | 'success' | 'error';
  providerId: string;
  data: Record<string, unknown>;
}

type AuthFile = Record<string, { type: 'oauth' } & OAuthCredentials>;

/** Minimal logger interface to avoid pino union-type issues. */
interface SimpleLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

// ─── Implementation ───

export class SubscriptionService {
  private dataDir: string;
  private logger: SimpleLogger;

  constructor(options: { dataDir: string; logger?: SimpleLogger }) {
    this.dataDir = options.dataDir;
    this.logger = options.logger ?? console;
  }

  /** Absolute path to auth.json. */
  private get authFile(): string {
    return join(this.dataDir, 'auth.json');
  }

  // ─── Credential I/O ──────────────────────────────────────────────────────

  /** Load credentials from disk. Returns empty object if file doesn't exist. */
  loadCredentials(): AuthFile {
    if (!existsSync(this.authFile)) {
      return {};
    }
    try {
      const raw = readFileSync(this.authFile, 'utf-8');
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as AuthFile;
      }
      return {};
    } catch (err) {
      this.logger.warn({ err, path: this.authFile }, '[subscription] Failed to load auth.json, ignoring');
      return {};
    }
  }

  /**
   * Save credentials to disk atomically.
   *
   * Writes to a temp file first, then renames into place so that concurrent
   * readers never see a partial write.
   */
  saveCredentials(auth: AuthFile): void {
    const tmpFile = this.authFile + '.tmp';
    mkdirSync(dirname(this.authFile), { recursive: true });
    writeFileSync(tmpFile, JSON.stringify(auth, null, 2), 'utf-8');
    renameSync(tmpFile, this.authFile);
  }

  // ─── Status ──────────────────────────────────────────────────────────────

  /** Get status for a single provider. */
  async getStatus(providerId: string): Promise<SubscriptionStatus> {
    const provider = getOAuthProvider(providerId);
    const auth = this.loadCredentials();
    const creds = auth[providerId];

    const status: SubscriptionStatus = {
      providerId,
      providerName: provider?.name ?? providerId,
      loggedIn: !!creds,
      expiresAt: creds?.expires ?? null,
    };

    // Try to refresh silently if expired — the creds may still be viable
    if (creds && Date.now() >= creds.expires) {
      try {
        const refreshed = await provider!.refreshToken(creds);
        auth[providerId] = { type: 'oauth', ...refreshed };
        this.saveCredentials(auth);
        status.expiresAt = refreshed.expires;
        status.loggedIn = true;
      } catch {
        // Token is truly expired / revoked
        status.loggedIn = false;
        status.expiresAt = null;
      }
    }

    return status;
  }

  /** List statuses for all registered OAuth providers. */
  async listStatuses(): Promise<SubscriptionStatus[]> {
    const providers = getOAuthProviders();
    const results: SubscriptionStatus[] = [];
    for (const p of providers) {
      results.push(await this.getStatus(p.id));
    }
    return results;
  }

  // ─── Login / Logout / Refresh ────────────────────────────────────────────

  /**
   * Initiate an OAuth login flow for the given provider.
   *
   * The `callbacks` object is used by the caller to handle user-facing
   * steps (showing auth URLs, device codes, prompts).
   *
   * On success the new credentials are atomically written to auth.json.
   */
  async login(providerId: string, callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    const provider = getOAuthProvider(providerId);
    if (!provider) {
      throw new Error(`Unknown OAuth provider: ${providerId}`);
    }

    this.logger.info({ providerId }, '[subscription] Starting login flow');
    const credentials = await provider.login(callbacks);

    const auth = this.loadCredentials();
    auth[providerId] = { type: 'oauth', ...credentials };
    this.saveCredentials(auth);

    this.logger.info({ providerId, expires: credentials.expires }, '[subscription] Login succeeded');
    return credentials;
  }

  /** Remove saved credentials for a provider. */
  async logout(providerId: string): Promise<void> {
    const auth = this.loadCredentials();
    if (auth[providerId]) {
      delete auth[providerId];
      this.saveCredentials(auth);
      this.logger.info({ providerId }, '[subscription] Logged out');
    }
  }

  /**
   * Force-refresh credentials for a provider.
   * Returns updated credentials or null if none were stored.
   */
  async refreshCredential(providerId: string): Promise<OAuthCredentials | null> {
    const provider = getOAuthProvider(providerId);
    if (!provider) {
      throw new Error(`Unknown OAuth provider: ${providerId}`);
    }

    const auth = this.loadCredentials();
    const creds = auth[providerId];
    if (!creds) return null;

    const refreshed = await provider.refreshToken(creds);
    auth[providerId] = { type: 'oauth', ...refreshed };
    this.saveCredentials(auth);

    return refreshed;
  }

  // ─── API Key resolution ──────────────────────────────────────────────────

  /**
   * Get the API key for a provider from stored OAuth credentials.
   *
   * Returns `null` if no credentials are stored or if the token is expired
   * and cannot be refreshed.  Automatically refreshes expired tokens and
   * persists the updated credentials.
   */
  async getApiKey(providerId: string): Promise<string | null> {
    const auth = this.loadCredentials();
    if (!auth[providerId]) return null;

    try {
      const result = await getOAuthApiKey(providerId, auth);
      if (!result) {
        // Credentials exist but we couldn't get a valid API key
        // (token expired and refresh failed — network, revoked, etc.)
        this.logger.debug({ providerId }, '[subscription] OAuth token expired and refresh failed, skipping');
        return null;
      }

      // Persist refreshed credentials
      auth[providerId] = { type: 'oauth', ...result.newCredentials };
      this.saveCredentials(auth);

      return result.apiKey;
    } catch (err) {
      // Only programming errors reach here (e.g. unknown provider id)
      this.logger.warn({ providerId, err }, '[subscription] Failed to get API key');
      return null;
    }
  }

  /**
   * Inject OAuth-derived API keys into the AppConfig's providerKeys map.
   *
   * Maps each OAuth provider to the corresponding pi-mono provider name
   * so that the agent factory can use subscription-backed models.
   *
   * Called at bootstrap and on every config hot-reload.
   */
  async applyCredentialsToConfig(config: AppConfig): Promise<void> {
    // Ensure providerKeys exists
    if (!config.providerKeys) {
      (config as unknown as Record<string, unknown>).providerKeys = {};
    }

    // Map OAuth provider IDs → pi-mono provider names in providerKeys
    const mappings: Array<{ oauthId: string; configKey: string }> = [
      { oauthId: 'anthropic', configKey: 'anthropic' },
      { oauthId: 'github-copilot', configKey: 'github-copilot' },
      { oauthId: 'openai-codex', configKey: 'openai-codex' },
    ];

    for (const { oauthId, configKey } of mappings) {
      const apiKey = await this.getApiKey(oauthId);
      if (apiKey) {
        if (!config.providerKeys[configKey]) {
          config.providerKeys[configKey] = {};
        }
        config.providerKeys[configKey].apiKey = apiKey;
        this.logger.debug({ configKey }, '[subscription] Injected OAuth API key into config');
      }
    }
  }
}
