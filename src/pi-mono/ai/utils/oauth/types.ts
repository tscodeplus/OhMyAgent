/**
 * Compatibility re-exports for project code that imports from utils/oauth/types.
 *
 * In pi v0.80.10, OAuth types were restructured. This file maintains the
 * old import surface so project code (subscription-service, login CLI, etc.)
 * doesn't need invasive changes. All types below preserve the v0.80.7 shape.
 */

import type { OAuthCredentials as NewOAuthCredentials } from "../../auth/types.js";

// Re-export OAuthCredentials under the old name
export type OAuthCredentials = NewOAuthCredentials;

// ── Callback types (v0.80.7 legacy shape) ────────────────────────────────

/** Prompt for user input (text, secret, select, manual_code). */
export interface OAuthPrompt {
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  allowEmpty?: boolean;
  options?: readonly { id: string; label: string; description?: string }[];
  signal?: AbortSignal;
}

/** Auth URL event. */
export interface OAuthAuthInfo {
  url: string;
  instructions?: string;
}

/** Device code event. */
export interface OAuthDeviceCodeInfo {
  userCode: string;
  verificationUri: string;
  intervalSeconds?: number;
  expiresInSeconds?: number;
}

/** Select prompt — v0.80.7 used a separate type for select options. */
export interface OAuthSelectPrompt {
  message: string;
  options: readonly { id: string; label: string; description?: string }[];
}

/**
 * Login callbacks — legacy v0.80.7 shape with individual handler properties.
 * The v0.80.10 OAuthAuth.login() takes AuthInteraction (unified prompt/notify),
 * so the compat layer in utils/oauth/index.ts adapts these callbacks.
 */
export interface OAuthLoginCallbacks {
  signal?: AbortSignal;
  onAuth: (info: OAuthAuthInfo) => void;
  onDeviceCode: (info: OAuthDeviceCodeInfo) => void;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
  onSelect: (prompt: OAuthSelectPrompt) => Promise<string>;
  onProgress: (message: string) => void;
  onManualCodeInput: () => Promise<string>;
}

// ── Provider-level types ──────────────────────────────────────────────────

export type OAuthProviderId = "anthropic" | "github-copilot" | "openai-codex" | "radius" | "xai";

export interface OAuthProviderInterface {
  readonly id: OAuthProviderId;
  readonly name: string;
  login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
  usesCallbackServer?: boolean;
  refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
  getApiKey(credentials: OAuthCredentials): string;
  modifyModels?(models: any[], credentials: OAuthCredentials): any[];
}

/** @deprecated Use OAuthProviderInterface instead */
export interface OAuthProviderInfo {
  id: OAuthProviderId;
  name: string;
  available: boolean;
}
