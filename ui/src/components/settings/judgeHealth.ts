/**
 * Judge-kernel readiness for the Models & Routing health bar.
 *
 * The two neighbouring dots (primary / embedding model) answer "is a provider
 * and a key configured?" and the judge dot answers the same question for the
 * judge chain — but the judge is an *optional* layer (`judge:` absent or
 * `enabled: false` leaves every hook a no-op), so it needs a fourth, neutral
 * state instead of borrowing the red "broken" one for "switched off".
 *
 * Chain selection mirrors `JudgeResolver.refsForPoint` (src/judge/judge-resolver.ts)
 * — `chain` when the WebUI wrote one, else the legacy `provider`/`modelRef` +
 * `fallbackTiers` derivation — and key presence comes from `GET /api/judge/config`
 * `keyStatus`, the only place that resolves provider keys *including env vars*.
 * Deriving that from `config.providerKeys` client-side would show a red dot for
 * every key supplied through the environment.
 */

/** off = layer inert, ok = whole chain usable, warn = some tiers usable, error = none. */
export type JudgeHealthTone = 'off' | 'ok' | 'warn' | 'error';

export interface JudgeHealth {
  tone: JudgeHealthTone;
  /** Configured chain entries with a usable key (and, for provider refs, a model). */
  usable: number;
  /** Distinct chain entries the kernel resolves, after dropping model-less groups. */
  total: number;
}

const OFF: JudgeHealth = { tone: 'off', usable: 0, total: 0 };

export const JUDGE_CUSTOM_PREFIX = 'judges.';

/** Builtin judge providers — mirrors JUDGE_PROVIDER_ENV_KEYS in src/judge/judge-resolver.ts. */
const JUDGE_PROVIDERS = new Set([
  'opencode',
  'typesafe',
  'vercel-ai-gateway',
  'openrouter',
  'cloudflare-workers-ai',
  'llama-cpp',
]);

/** Providers that need no key at all (`JUDGE_PROVIDER_ENV_KEYS[..].length === 0`). */
const KEYLESS_PROVIDERS = new Set(['llama-cpp']);

/** Server shape of `GET /api/judge/config` (only the fields this module reads). */
export interface JudgeConfigResponse {
  /** Effective `judge:` section — already defaulted by `judgeSectionSchema`. */
  config?: {
    enabled?: unknown;
    provider?: unknown;
    modelRef?: unknown;
    fallbackTiers?: unknown;
    chain?: unknown;
    routes?: unknown;
    judges?: unknown;
  };
  /** `Record<provider, { present, envVars, accountId? }>` (older servers: booleans). */
  keyStatus?: unknown;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asRefList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim())
        .filter((v) => v !== '')
    : [];
}

/** A bare builtin provider id marks an added-but-model-less group the resolver skips. */
function isModelLessGroup(ref: string): boolean {
  return !ref.includes('/') && !ref.startsWith(JUDGE_CUSTOM_PREFIX) && JUDGE_PROVIDERS.has(ref);
}

/** Legacy path: `provider` + `modelRef` (in either ref spelling) then `fallbackTiers`. */
function legacyRefs(config: NonNullable<JudgeConfigResponse['config']>): string[] {
  const provider = asString(config.provider).trim();
  const modelRef = asString(config.modelRef).trim();
  const primary =
    provider === 'judges' && modelRef
      ? `${JUDGE_CUSTOM_PREFIX}${modelRef}`
      : provider && modelRef
        ? `${provider}/${modelRef}`
        : '';
  return [...(primary ? [primary] : []), ...asRefList(config.fallbackTiers)];
}

/**
 * Every distinct ref the kernel can resolve: the default chain plus any
 * per-decision-point `routes` override (which replaces the chain for that
 * point). Union rather than default-only so a kernel that works through
 * routes alone is not reported as broken.
 */
function activeRefs(config: NonNullable<JudgeConfigResponse['config']>): string[] {
  const chain = asRefList(config.chain);
  const routes =
    config.routes && typeof config.routes === 'object'
      ? Object.values(config.routes as Record<string, unknown>).flatMap((refs) => asRefList(refs))
      : [];
  const refs = chain.length > 0 ? [...chain, ...routes] : [...legacyRefs(config), ...routes];
  return [...new Set(refs)].filter((ref) => !isModelLessGroup(ref));
}

/** Provider key present, per `buildKeyStatus` in src/app/webui/judge-routes.ts. */
function providerKeyPresent(keyStatus: unknown, provider: string): boolean {
  if (KEYLESS_PROVIDERS.has(provider)) return true;
  if (!keyStatus || typeof keyStatus !== 'object') return false;
  const entry = (keyStatus as Record<string, unknown>)[provider];
  if (entry === true) return true;
  if (!entry || typeof entry !== 'object') return false;
  if ((entry as { present?: unknown }).present !== true) return false;
  // Cloudflare additionally needs an account id to build the endpoint URL.
  if (provider === 'cloudflare-workers-ai') {
    const account = (entry as { accountId?: { present?: unknown } }).accountId;
    return !!account && typeof account === 'object' && account.present === true;
  }
  return true;
}

/**
 * A ref is usable when it points at a *configured* judge:
 * - `judges.<name>` → the custom entry carries an inline key or an apiKeyEnv
 *   (the server resolves the env var; the WebUI cannot read it, so an env name
 *   counts as configured);
 * - `<provider>/<model>` → the provider key is present. Providers absent from
 *   `keyStatus` (hand-written refs outside the builtin catalog) count as
 *   usable: the dot reports what it can verify, and the ledger surfaces the
 *   real call failures.
 */
function isUsableRef(ref: string, judges: Record<string, unknown>, keyStatus: unknown): boolean {
  if (ref.startsWith(JUDGE_CUSTOM_PREFIX)) {
    const entry = judges[ref.slice(JUDGE_CUSTOM_PREFIX.length)];
    if (!entry || typeof entry !== 'object') return false;
    const { apiKey, apiKeyEnv } = entry as { apiKey?: unknown; apiKeyEnv?: unknown };
    return asString(apiKey) !== '' || asString(apiKeyEnv) !== '';
  }
  const provider = ref.split('/')[0];
  if (!JUDGE_PROVIDERS.has(provider)) return true;
  return providerKeyPresent(keyStatus, provider);
}

/**
 * Judge-kernel dot state. Unknown / absent payloads are `off`: a server without
 * the judge routes (or with no `judge:` section) has an inert kernel, which is
 * a legitimate configuration, not an error.
 */
export function deriveJudgeHealth(payload: JudgeConfigResponse | null | undefined): JudgeHealth {
  const config = payload?.config;
  if (!config || config.enabled !== true) return OFF;

  const refs = activeRefs(config);
  if (refs.length === 0) return { tone: 'error', usable: 0, total: 0 };

  const judges =
    config.judges && typeof config.judges === 'object'
      ? (config.judges as Record<string, unknown>)
      : {};
  const usable = refs.filter((ref) => isUsableRef(ref, judges, payload?.keyStatus)).length;

  const tone: JudgeHealthTone = usable === 0 ? 'error' : usable === refs.length ? 'ok' : 'warn';
  return { tone, usable, total: refs.length };
}
