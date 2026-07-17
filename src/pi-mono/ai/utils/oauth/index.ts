/**
 * Compatibility OAuth provider registry — wraps v0.80.10 OAuthAuth objects
 * in the legacy OAuthProviderInterface shape used by subscription-service,
 * login CLI, and subscription-routes.
 */

import type { AuthEvent, AuthPrompt, OAuthAuth } from "../../auth/types.js";
import type {
  OAuthAuthInfo,
  OAuthCredentials,
  OAuthDeviceCodeInfo,
  OAuthLoginCallbacks,
  OAuthProviderId,
  OAuthProviderInterface,
  OAuthProviderInfo,
} from "./types.js";

// Loaders from the new auth/oauth module
import {
  loadAnthropicOAuth,
  loadGitHubCopilotOAuth,
  loadOpenAICodexOAuth,
  loadRadiusOAuth,
  loadXaiOAuth,
} from "../../auth/oauth/load.js";
import { getProviderEnvValue } from "../provider-env.js";

const DEFAULT_RADIUS_GATEWAY = "https://radius.earendil-works.com";

// ── Adapt old callbacks → new AuthInteraction ────────────────────────────

function toAuthInteraction(callbacks: OAuthLoginCallbacks): {
  signal?: AbortSignal;
  prompt(p: AuthPrompt): Promise<string>;
  notify(e: AuthEvent): void;
} {
  return {
    signal: callbacks.signal,
    async prompt(p: AuthPrompt): Promise<string> {
      switch (p.type) {
        case "text":
        case "secret":
          return callbacks.onPrompt({ type: p.type, message: p.message, placeholder: p.placeholder });
        case "select":
          return callbacks.onSelect({
            message: p.message,
            options: (p.options ?? []) as unknown as readonly {
              id: string;
              label: string;
              description?: string;
            }[],
          });
        case "manual_code":
          return callbacks.onManualCodeInput();
        default:
          return "";
      }
    },
    notify(e: AuthEvent): void {
      switch (e.type) {
        case "auth_url":
          callbacks.onAuth({ url: e.url!, instructions: e.instructions });
          break;
        case "device_code":
          callbacks.onDeviceCode({
            userCode: e.userCode!,
            verificationUri: e.verificationUri!,
            intervalSeconds: e.intervalSeconds,
            expiresInSeconds: e.expiresInSeconds,
          });
          break;
        case "progress":
          callbacks.onProgress(e.message!);
          break;
      }
    },
  };
}

// ── Adapt OAuthAuth → OAuthProviderInterface ──────────────────────────────

function adaptOAuthAuth(
  id: OAuthProviderId,
  name: string,
  getAuth: () => Promise<OAuthAuth>,
): OAuthProviderInterface {
  let cached: OAuthAuth | undefined;

  async function auth(): Promise<OAuthAuth> {
    if (!cached) cached = await getAuth();
    return cached;
  }

  return {
    id,
    name,
    async login(callbacks: OAuthLoginCallbacks) {
      const interaction = toAuthInteraction(callbacks);
      const credential = await (await auth()).login(interaction);
      // OAuthCredential extends OAuthCredentials with `type: "oauth"`
      return { access: credential.access, refresh: credential.refresh, expires: credential.expires };
    },
    async refreshToken(credentials: OAuthCredentials) {
      const refreshed = await (await auth()).refresh(credentials as any);
      return { access: refreshed.access, refresh: refreshed.refresh, expires: refreshed.expires };
    },
    getApiKey(credentials: OAuthCredentials) {
      return credentials.access;
    },
  };
}

// ── Provider instances (lazily loaded) ────────────────────────────────────

const BUILTIN_DEFS: Array<{
  id: OAuthProviderId;
  name: string;
  loader: () => Promise<OAuthAuth>;
}> = [
  { id: "anthropic", name: "Anthropic (Claude Pro/Max)", loader: loadAnthropicOAuth },
  { id: "github-copilot", name: "GitHub Copilot", loader: loadGitHubCopilotOAuth },
  { id: "openai-codex", name: "OpenAI Codex (ChatGPT)", loader: loadOpenAICodexOAuth },
  { id: "xai", name: "xAI (Grok)", loader: loadXaiOAuth },
  {
    id: "radius",
    name: "Radius",
    loader: () =>
      loadRadiusOAuth({
        name: "Radius",
        gateway: getProviderEnvValue("PI_GATEWAY") || DEFAULT_RADIUS_GATEWAY,
      }),
  },
];

const builtins = new Map<string, OAuthProviderInterface>(
  BUILTIN_DEFS.map((d) => [d.id, adaptOAuthAuth(d.id, d.name, d.loader)]),
);

// ── Registry ──────────────────────────────────────────────────────────────

const registry = new Map(builtins);

export function getOAuthProvider(id: string): OAuthProviderInterface | undefined {
  return registry.get(id);
}

export function getOAuthProviders(): OAuthProviderInterface[] {
  return Array.from(registry.values());
}

export function registerOAuthProvider(provider: OAuthProviderInterface): void {
  registry.set(provider.id, provider);
}

export function unregisterOAuthProvider(id: string): void {
  const builtin = builtins.get(id);
  if (builtin) {
    registry.set(id, builtin);
  } else {
    registry.delete(id);
  }
}

export function resetOAuthProviders(): void {
  registry.clear();
  for (const [id, provider] of builtins) {
    registry.set(id, provider);
  }
}

/** @deprecated Use getOAuthProviders() */
export function getOAuthProviderInfoList(): OAuthProviderInfo[] {
  return getOAuthProviders().map((p) => ({
    id: p.id as OAuthProviderId,
    name: p.name,
    available: true,
  }));
}

// ── High-level API ────────────────────────────────────────────────────────

export async function refreshOAuthToken(
  providerId: OAuthProviderId,
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  const provider = getOAuthProvider(providerId);
  if (!provider) throw new Error(`Unknown OAuth provider: ${providerId}`);
  return provider.refreshToken(credentials);
}

export async function getOAuthApiKey(
  providerId: string,
  credentials: Record<string, OAuthCredentials>,
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
  const provider = getOAuthProvider(providerId);
  if (!provider) throw new Error(`Unknown OAuth provider: ${providerId}`);

  const creds = credentials[providerId];
  if (!creds) return null;

  // Refresh if expired
  let currentCreds = creds;
  if (Date.now() >= creds.expires) {
    try {
      currentCreds = await provider.refreshToken(creds);
    } catch {
      throw new Error(`Failed to refresh OAuth token for ${providerId}`);
    }
  }

  const apiKey = provider.getApiKey(currentCreds);
  return { newCredentials: currentCreds, apiKey };
}
