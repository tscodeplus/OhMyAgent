/**
 * Judge resolver — explicit, config-driven judge chain resolution.
 *
 * NO env-detection chain (plan §4/§8: config.yaml is the single source of
 * truth; implicit provider priority would make behavior invisible when several
 * keys coexist). The main chain is `[provider/modelRef, ...fallbackTiers]`;
 * `routes[pointId]` replaces the whole chain when present.
 *
 * Ref syntax:
 *   classifier:<provider>/<model>   canonical (any pi-mono classifier model)
 *   <provider>/<model>              shorthand, same as above
 *   jev-free                        = opencode/jev-1.13-free
 *   llm:<provider>/<model>          phase-3 placeholder → JudgeError('unsupported')
 *
 * Key presence follows how OhMyAgent resolves provider keys today:
 * `provider_keys` config > custom providers > `piAi` primary > pi-mono env
 * mapping (OPENCODE_API_KEY, TYPESAFE_API_KEY, AI_GATEWAY_API_KEY,
 * OPENROUTER_API_KEY, CLOUDFLARE_API_KEY + CLOUDFLARE_ACCOUNT_ID). A chain
 * member without its key is dropped and warn-reported once per startup, not
 * per call; the engine records fallbackReason `'no-key'`.
 *
 * Custom relay judges (plan §8.1 `judge.judges`, milestone M5): every entry
 * (record order) is auto-prepended ABOVE the built-in chain — including above
 * any `routes[pointId]` override. judgeId = entry name; the wire model id comes
 * from the entry's `model` (default CUSTOM_JUDGE_DEFAULT_MODEL). Keys are read
 * only from the entry's `apiKeyEnv` env var name — config.yaml stays the single
 * source of truth, no provider/env probing.
 */

import {
  getModel,
  getModelType,
  registerModel,
  type ClassifierApi,
  type ClassifierModel,
  type Models,
} from '@earendil-works/pi-ai';

/** Catalog entries are unconstrained across APIs — every ClassifierApi counts. */
type AnyClassifierModel = ClassifierModel<ClassifierApi>;
import { builtinModels, getBuiltinClassifierModel } from '../pi-mono/ai/providers/all.js';
import type { CustomProviderConfig } from '../app/types.js';
import type { Logger } from 'pino';
import { FREE_JEV_MODEL_ID } from './free-jev.js';
import { classifyCustomJudge } from './protocol-map.js';
import { JudgeError, type JudgeEntryConfig, type JudgeTier } from './types.js';

/** Env-var names each judge provider reads — mirrors pi-mono env-api-keys + the Cloudflare account id. */
export const JUDGE_PROVIDER_ENV_KEYS: Record<string, readonly string[]> = {
  opencode: ['OPENCODE_API_KEY'],
  typesafe: ['TYPESAFE_API_KEY'],
  'vercel-ai-gateway': ['AI_GATEWAY_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  'cloudflare-workers-ai': ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID'],
  // Local llama.cpp classifier server (Reflex / Laya local) — keyless.
  'llama-cpp': [],
};

export interface ParsedJudgeRef {
  provider: string;
  modelId: string;
}

/**
 * Parse a judge ref. Throws JudgeError for malformed and unsupported refs.
 * The free-tier alias `jev-free` expands to the catalog entry
 * `opencode/jev-1.13-free`.
 */
export function parseJudgeRef(ref: string): ParsedJudgeRef {
  let rest = ref.trim();
  if (rest.length === 0) {
    throw new JudgeError('invalid-ref', 'Empty judge ref');
  }
  if (rest === 'jev-free') {
    return { provider: 'opencode', modelId: FREE_JEV_MODEL_ID };
  }
  // llm:<provider>/<model> is the phase-3 chat-model+JSON adapter.
  if (rest.startsWith('llm:')) {
    throw new JudgeError(
      'unsupported',
      `Judge ref "${ref}": the llm: adapter is planned for phase 3 and not supported yet`,
    );
  }
  if (rest.startsWith('classifier:')) {
    rest = rest.slice('classifier:'.length);
  }
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) {
    throw new JudgeError(
      'invalid-ref',
      `Judge ref "${ref}": expected "<provider>/<model>" (e.g. "opencode/jev-1.13")`,
    );
  }
  return { provider: rest.slice(0, slash), modelId: rest.slice(slash + 1) };
}

export function judgeIdOf(ref: ParsedJudgeRef): string {
  return `${ref.provider}/${ref.modelId}`;
}

/** Providers/refs that need no provider key (free tier, local classifier server). */
function isKeylessRef(provider: string, modelId: string): boolean {
  if (provider === 'opencode' && modelId === FREE_JEV_MODEL_ID) return true;
  return JUDGE_PROVIDER_ENV_KEYS[provider]?.length === 0;
}

export interface JudgeResolverOptions {
  config: import('./types.js').JudgeSectionConfig;
  logger: Logger;
  /** `provider_keys` config section (WebUI-managed provider keys). */
  providerKeys?: Record<string, { apiKey?: string; baseUrl?: string }>;
  customProviders?: CustomProviderConfig[];
  /** Primary (`piAi`) provider credentials — count as a key source for that provider. */
  piAiProvider?: string;
  piAiApiKey?: string;
  /**
   * Scoped env map for key lookup. When provided it is the ONLY env source
   * (no process.env fallback), which keeps no-key behavior testable and
   * host-env independent. Default: process.env.
   */
  env?: Record<string, string | undefined>;
}

/** pi-mono Models instance backing every tier's classify (same instance reused). */
let judgeModelsInstance: Models | undefined;
export function getJudgeModels(): Models {
  judgeModelsInstance ??= builtinModels();
  return judgeModelsInstance;
}

/** Test hook: forget the shared Models instance. */
export function resetJudgeModels(): void {
  judgeModelsInstance = undefined;
}

/** pi-mono compat registry (registerModel) is process-global: register once. */
const registeredHiddenSlugs = new Set<string>();

/** The OpenRouter hidden Jev slug — the generated catalog entry some versions carry as hidden. */
const OPENROUTER_HIDDEN_JEV = '~typesafe/jev-latest';

export class JudgeResolver {
  private readonly opts: JudgeResolverOptions;
  /** Refs already warn-reported for missing keys — at most once per startup. */
  private readonly noKeyWarned = new Set<string>();

  constructor(options: JudgeResolverOptions) {
    this.opts = options;
  }

  /** Refs the point resolves to: routes replace the whole chain; else [main, ...fallbackTiers]. */
  private refsForPoint(pointId: string): string[] {
    const config = this.opts.config;
    const routeRefs = config.routes?.[pointId]?.map((r) => r.trim()).filter(Boolean) ?? [];
    if (routeRefs.length > 0) return routeRefs;
    const main = config.provider && config.modelRef ? `${config.provider}/${config.modelRef}` : '';
    const fallback = (config.fallbackTiers ?? []).map((r) => r.trim()).filter(Boolean);
    return [...(main ? [main] : []), ...fallback];
  }

  /**
   * Resolve the chain for one decision point. Never throws: unresolvable refs
   * land in `unresolvableRefs`. Custom relay judges (config record order) are
   * auto-prepended ABOVE the built-in chain, including above any routes
   * override; they report by entry name as `judges.<name>`.
   */
  resolveChain(pointId: string): {
    tiers: JudgeTier[];
    noKeyRefs: string[];
    unresolvableRefs: string[];
  } {
    const tiers: JudgeTier[] = [];
    const noKeyRefs: string[] = [];
    const unresolvableRefs: string[] = [];
    for (const [name, entry] of Object.entries(this.opts.config.judges ?? {})) {
      const ref = `judges.${name}`;
      try {
        this.validateCustomJudgeEntry(name, entry);
        const apiKey = entry.apiKeyEnv ? this.envValue(entry.apiKeyEnv) : undefined;
        if (!apiKey) {
          noKeyRefs.push(ref);
          this.warnNoKeyOnce(ref, name, entry.apiKeyEnv ? [entry.apiKeyEnv] : []);
          continue;
        }
        tiers.push({
          judgeId: name,
          classify: (context, call) =>
            classifyCustomJudge(entry, context, {
              apiKey,
              ...(call.signal ? { signal: call.signal } : {}),
              ...(call.timeoutMs !== undefined ? { timeoutMs: call.timeoutMs } : {}),
            }),
        });
      } catch (err) {
        unresolvableRefs.push(ref);
        this.opts.logger.warn(
          { err, ref },
          'Judge ref could not be resolved (dropped from the chain)',
        );
      }
    }
    for (const ref of this.refsForPoint(pointId)) {
      try {
        const parsed = parseJudgeRef(ref);
        const keyless = isKeylessRef(parsed.provider, parsed.modelId);
        // Prefer the REAL provider key even for keyless (free/local) tiers:
        // OpenCode's System One endpoint currently rejects placeholder Bearer
        // values with 401 even on jev-1.13-free (the key just marks the
        // account; the free tier still costs nothing). The placeholder is a
        // last resort for genuinely keyless endpoints (local llama.cpp).
        const apiKey = this.resolveApiKey(parsed.provider);
        // Free tier without an OpenCode key still goes out (the endpoint is
        // unauthenticated); system-one transport needs a non-empty Bearer, so
        // a placeholder is sent and a 401s surface as a regular service error.
        const effectiveApiKey = apiKey ?? (keyless ? 'no-opencode-key' : undefined);
        if (!keyless && !apiKey) {
          noKeyRefs.push(ref);
          this.warnNoKeyOnce(ref, parsed.provider);
          continue;
        }
        const model = this.resolveModelEntry(parsed.provider, parsed.modelId);
        tiers.push({
          judgeId: judgeIdOf(parsed),
          classify: (context, call) => {
            const models = getJudgeModels();
            return models.classify(model, context, {
              ...(effectiveApiKey !== undefined ? { apiKey: effectiveApiKey } : {}),
              ...(parsed.provider === 'cloudflare-workers-ai' ? { env: this.cloudflareEnv() } : {}),
              ...(call.signal ? { signal: call.signal } : {}),
              ...(call.timeoutMs !== undefined ? { timeoutMs: call.timeoutMs } : {}),
            });
          },
        });
      } catch (err) {
        unresolvableRefs.push(ref);
        this.opts.logger.warn(
          { err, ref },
          'Judge ref could not be resolved (dropped from the chain)',
        );
      }
    }
    return { tiers, noKeyRefs, unresolvableRefs };
  }

  /** A custom judge entry must carry an absolute http(s) baseUrl and a known wire type. */
  private validateCustomJudgeEntry(name: string, entry: JudgeEntryConfig): void {
    if (entry.type !== 'typesafe' && entry.type !== 'http') {
      throw new JudgeError(
        'invalid-ref',
        `Custom judge "${name}": unknown type "${String(entry.type)}"`,
      );
    }
    if (!entry.baseUrl) {
      throw new JudgeError('invalid-ref', `Custom judge "${name}": baseUrl is required`);
    }
    if (!URL.canParse(entry.baseUrl)) {
      throw new JudgeError(
        'invalid-ref',
        `Custom judge "${name}": baseUrl must be an absolute URL`,
      );
    }
    if (entry.model !== undefined && entry.model.trim().length === 0) {
      throw new JudgeError(
        'invalid-ref',
        `Custom judge "${name}": model must be a non-empty string`,
      );
    }
  }

  /**
   * Look up the classifier model. Classifier models live in the generated
   * CLASSIFIER catalog (NOT in compat getModel's chat catalog), so the primary
   * read is getBuiltinClassifierModel; compat getModel supplies
   * registerModel-registered customs (and the OpenRouter hidden slug once a
   * previous call synthesized it).
   */
  private resolveModelEntry(provider: string, modelId: string): AnyClassifierModel {
    const builtin = getBuiltinClassifierModel(provider as never, modelId as never) as
      AnyClassifierModel | undefined;
    if (builtin && getModelType(builtin) === 'classifier') return builtin;
    const compat = getModel(provider as never, modelId as never) as AnyClassifierModel | undefined;
    if (compat) {
      if (getModelType(compat) !== 'classifier') {
        throw new JudgeError(
          'not-classifier',
          `Model ${provider}/${modelId} is not a classifier model (type: ${getModelType(compat)})`,
        );
      }
      return compat;
    }
    if (provider === 'openrouter' && modelId === OPENROUTER_HIDDEN_JEV) {
      return this.registerHiddenSlug();
    }
    throw new JudgeError(
      'unknown-model',
      `Classifier model not found: ${provider}/${modelId} (not in the pi-mono catalog)`,
    );
  }

  private registerHiddenSlug(): AnyClassifierModel {
    const model: AnyClassifierModel = {
      type: 'classifier',
      id: OPENROUTER_HIDDEN_JEV,
      name: 'TypeSafe: Jev Latest',
      api: 'typesafe-system-one',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      input: ['text'],
      cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32000,
    };
    if (!registeredHiddenSlugs.has(OPENROUTER_HIDDEN_JEV)) {
      registerModel(
        'openrouter',
        OPENROUTER_HIDDEN_JEV,
        model as unknown as Parameters<typeof registerModel>[2],
      );
      registeredHiddenSlugs.add(OPENROUTER_HIDDEN_JEV);
      this.opts.logger.info(
        'Registered OpenRouter hidden Jev slug ~typesafe/jev-latest into the model registry',
      );
    }
    return model;
  }

  /**
   * Key for a provider: `provider_keys` config > custom providers > primary
   * (`piAi`) > the provider's env var (pi-mono mapping). Cloudflare
   * additionally requires CLOUDFLARE_ACCOUNT_ID — the key alone cannot build
   * the endpoint URL.
   */
  private resolveApiKey(provider: string): string | undefined {
    if (provider === 'cloudflare-workers-ai') {
      const key = this.envValue('CLOUDFLARE_API_KEY');
      if (!key) return undefined;
      return this.envValue('CLOUDFLARE_ACCOUNT_ID') ? key : undefined;
    }
    const configKey = this.opts.providerKeys?.[provider]?.apiKey;
    if (configKey) return configKey;
    const custom = this.opts.customProviders?.find((p) => p.provider === provider);
    if (custom?.apiKey) return custom.apiKey;
    if (provider === this.opts.piAiProvider && this.opts.piAiApiKey) return this.opts.piAiApiKey;
    const envVar = JUDGE_PROVIDER_ENV_KEYS[provider]?.[0];
    return envVar ? this.envValue(envVar) : undefined;
  }

  /**
   * Scoped-or-process env lookup for one provider env var. An explicit
   * `opts.env` map is the ONLY env source when provided.
   */
  private envValue(name: string): string | undefined {
    if (this.opts.env) {
      const scoped = this.opts.env[name];
      return typeof scoped === 'string' && scoped.length > 0 ? scoped : undefined;
    }
    const direct = typeof process !== 'undefined' ? process.env[name] : undefined;
    return typeof direct === 'string' && direct.length > 0 ? direct : undefined;
  }

  private cloudflareEnv(): Record<string, string> | undefined {
    const accountId = this.envValue('CLOUDFLARE_ACCOUNT_ID');
    return accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : undefined;
  }

  private warnNoKeyOnce(ref: string, provider: string, envNames?: readonly string[]): void {
    if (this.noKeyWarned.has(ref)) return;
    this.noKeyWarned.add(ref);
    const envVarNames = envNames ?? JUDGE_PROVIDER_ENV_KEYS[provider];
    this.opts.logger.warn(
      {
        ref,
        provider,
        envVar: envVarNames?.join(', '),
        hint: 'Set the provider key in config.yaml provider_keys or the env var above',
      },
      'Judge ref dropped from the chain: no provider key (fallbackReason=no-key)',
    );
  }
}
