/**
 * Judge kernel API routes (MyDocs/JEV_JUDGE_KERNEL_IMPLEMENTATION.md §5.5).
 *
 * GET  /api/judge/config — effective judge section + per-provider key status
 *                          + classifier model catalog grouped by provider.
 * GET  /api/judge/status — enabled flag, decision-point mode table, recent
 *                          ledger entries, circuit-breaker states.
 * GET  /api/judge/ledger — paged ledger query (query params page, pageSize,
 *                          pointId, mode, outcome, from, to, session) →
 *                          { entries, total, page, pageSize }.
 * POST /api/judge/test   — one golden sample (choice/noul/score) through the
 *                          live engine; judge-side problems never become 500s.
 * POST /api/judge/config — persist the judge section of config.yaml.
 * POST /api/judge/key   — store one provider's API key (and/or Cloudflare
 *              account id) into config.yaml `provider_keys` (snake_case:
 *              api_key/account_id), merge semantics per provider; an emptied
 *              entry is deleted. Empty-string field values are the clear
 *              sentinel (env vars still count afterwards).
 */

import type { FastifyInstance } from 'fastify';
import { getModels } from '@earendil-works/pi-ai';
import { getModelType } from '@earendil-works/pi-ai';
import { judgeSectionSchema, loadConfig } from '../config.js';
import type { AppConfig, AppServices } from '../types.js';
import { DECISION_POINT_IDS } from '../../judge/decisions/registry.js';
import { goldenSampleSpec, GOLDEN_SAMPLE_STATE } from '../../judge/golden-sample.js';
import { auditOnce } from '../judge-autopilot.js';
import { JUDGE_PROVIDER_ENV_KEYS } from '../../judge/judge-resolver.js';
import { mutateConfigYaml, readConfigObject, applyConfigObject } from './yaml-mutation.js';

/** Providers whose classifier models the judge tab enumerates. */
const JUDGE_CONFIG_PROVIDERS: readonly string[] = [
  'opencode',
  'typesafe',
  'vercel-ai-gateway',
  'cloudflare-workers-ai',
  'openrouter',
];

/** The hidden OpenRouter slug must always be present in the openrouter group. */
const OPENROUTER_HIDDEN_JEV = '~typesafe/jev-latest';

export interface JudgeRouteConfig {
  getConfig: () => AppConfig;
  getJudge: () => AppServices['judge'];
  /** Fired after the judge section is persisted (hot reload of the section). */
  onConfigSaved?: (newConfig: AppConfig) => void;
}

function isNonEmptyEnv(name: string): boolean {
  const v = process.env[name];
  return typeof v === 'string' && v.length > 0;
}

/** Per-provider key status for the judge tab (GET config + POST key reuse). */
function buildKeyStatus(appConfig: AppConfig): Record<
  string,
  {
    envVars: string[];
    present: boolean;
    fromConfig: boolean;
    envPresent: boolean;
    accountId?: { fromConfig: boolean; envPresent: boolean; present: boolean };
  }
> {
  const keyStatus: Record<
    string,
    {
      envVars: string[];
      present: boolean;
      fromConfig: boolean;
      envPresent: boolean;
      accountId?: { fromConfig: boolean; envPresent: boolean; present: boolean };
    }
  > = {};
  for (const [provider, envVars] of Object.entries(JUDGE_PROVIDER_ENV_KEYS)) {
    const fromConfig = Boolean(appConfig.providerKeys?.[provider]?.apiKey);
    let envPresent = false;
    if (provider === 'cloudflare-workers-ai') {
      envPresent = isNonEmptyEnv('CLOUDFLARE_API_KEY') && isNonEmptyEnv('CLOUDFLARE_ACCOUNT_ID');
    } else if (provider === 'opencode') {
      // jev-1.13-free needs no key; any presence is reported for the paid tier.
      envPresent = isNonEmptyEnv('OPENCODE_API_KEY');
    } else {
      envPresent = envVars.some((name) => isNonEmptyEnv(name));
    }
    const status: {
      envVars: string[];
      present: boolean;
      fromConfig: boolean;
      envPresent: boolean;
      accountId?: { fromConfig: boolean; envPresent: boolean; present: boolean };
    } = {
      envVars: [...envVars],
      fromConfig,
      envPresent,
      present: fromConfig || envPresent || provider === 'opencode',
    };
    // Cloudflare needs an account id on top of the API key to build the
    // endpoint URL — report where each side comes from, never the value.
    if (provider === 'cloudflare-workers-ai') {
      const accountFromConfig = Boolean(appConfig.providerKeys?.[provider]?.accountId);
      const accountEnvPresent = isNonEmptyEnv('CLOUDFLARE_ACCOUNT_ID');
      status.accountId = {
        fromConfig: accountFromConfig,
        envPresent: accountEnvPresent,
        present: accountFromConfig || accountEnvPresent,
      };
    }
    keyStatus[provider] = status;
  }
  return keyStatus;
}

export function registerJudgeRoutes(app: FastifyInstance, cfg: JudgeRouteConfig): void {
  // Effective judge section + provider key status + classifier model catalog.
  app.get('/api/judge/config', async (_request, reply) => {
    const config = judgeSectionSchema.parse(cfg.getConfig().judge ?? {});
    const keyStatus = buildKeyStatus(cfg.getConfig());

    const models: Record<string, string[]> = {};
    for (const provider of JUDGE_CONFIG_PROVIDERS) {
      let list: string[] = [];
      try {
        list = getModels(provider as never)
          .filter((m) => getModelType(m) === 'classifier')
          .map((m) => m.id);
      } catch {
        list = [];
      }
      if (provider === 'openrouter' && !list.includes(OPENROUTER_HIDDEN_JEV)) {
        list.push(OPENROUTER_HIDDEN_JEV);
      }
      models[provider] = list;
    }

    return reply.send({ config, models, keyStatus });
  });

  // Decision-point mode matrix + recent ledger + breaker states.
  app.get('/api/judge/status', async (_request, reply) => {
    const judge = cfg.getJudge();
    const config = judgeSectionSchema.parse(cfg.getConfig().judge ?? {});
    const def = config.modes.default ?? 'shadow';
    return reply.send({
      enabled: judge !== undefined,
      modes: {
        default: def,
        points: DECISION_POINT_IDS.map((id) => ({ id, mode: config.modes[id] ?? def })),
      },
      recent: judge?.ledger.recent(20) ?? [],
      breaker: judge?.breaker.states() ?? [],
      recordState: config.recordState,
      timeoutMs: config.timeoutMs,
    });
  });

  // Paged ledger query (MyDocs/JEV_JUDGE_KERNEL_IMPLEMENTATION.md §5 item 4).
  // Contract is exact — the WebUI ledger panel consumes {entries,total,page,
  // pageSize} with entries = one page of LedgerRecord, newest first.
  app.get('/api/judge/ledger', async (request, reply) => {
    const query = request.query as Record<string, string | undefined> | undefined;
    const numberParam = (name: string): number | undefined => {
      const raw = query?.[name];
      if (raw === undefined || raw === '') return undefined;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
    };
    const stringParam = (name: string): string | undefined => {
      const raw = query?.[name];
      return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
    };
    const judge = cfg.getJudge();
    // Engine absent (judge disabled) → every hook point is a no-op, so the
    // ledger by definition has nothing to answer with.
    if (!judge) {
      return reply.send({
        entries: [],
        total: 0,
        page: numberParam('page') ?? 1,
        pageSize: numberParam('pageSize') ?? 20,
      });
    }
    const result = judge.ledger.query({
      page: numberParam('page'),
      pageSize: numberParam('pageSize'),
      pointId: stringParam('pointId'),
      mode: stringParam('mode'),
      outcome: stringParam('outcome'),
      from: stringParam('from'),
      to: stringParam('to'),
      session: stringParam('session'),
    });
    return reply.send(result);
  });

  // One golden sample through the live engine. Judge-side problems are
  // returned in-band, never as a 500.
  // Read-only autopilot telemetry for the WebUI judges tab (dry run: reports
  // per-point stats and pending gate decisions, config untouched).
  app.get('/api/judge/autopilot', async (_request, reply) => {
    try {
      const report = await auditOnce(
        {
          ledgerDir: './data/judge-ledger',
          judge: cfg.getConfig().judge,
          getConfig: cfg.getConfig,
          onConfigSaved: (newConfig) => cfg.onConfigSaved?.(newConfig),
          logger: app.log,
        },
        { apply: false },
      );
      return reply.send({ ok: true, ...report });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ ok: false, error: 'Internal Server Error', message });
    }
  });

  // Manual autopilot audit trigger — same statistical gates the interval uses.
  // Idempotent and non-destructive: points failing the gate simply hold.
  app.post('/api/judge/autopilot', async (_request, reply) => {
    try {
      const report = await auditOnce({
        ledgerDir: './data/judge-ledger',
        judge: cfg.getConfig().judge,
        getConfig: cfg.getConfig,
        onConfigSaved: (newConfig) => cfg.onConfigSaved?.(newConfig),
        logger: app.log,
      });
      return reply.send({ ok: true, ...report });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ ok: false, error: 'Internal Server Error', message });
    }
  });

  app.post('/api/judge/test', async (_request, reply) => {
    const judge = cfg.getJudge();
    const started = Date.now();
    if (!judge) {
      return reply.send({
        ok: false,
        errorMessage: 'Judge engine is not enabled (judge.enabled=false or no usable judge)',
        answers: {},
        judgeId: '',
        latencyMs: 0,
      });
    }
    try {
      const verdict = await judge.decide(goldenSampleSpec(), {
        state: GOLDEN_SAMPLE_STATE,
        sessionId: 'judge-test',
      });
      return reply.send({
        ok: verdict.source === 'judge',
        latencyMs: verdict.latencyMs,
        answers: verdict.answers,
        judgeId: verdict.judgeId,
        errorMessage:
          verdict.source === 'judge'
            ? undefined
            : `judge fallback (${verdict.fallbackReason ?? 'unknown'})`,
      });
    } catch (err) {
      // JudgeEngine.decide() never rejects — this is a pure safety net.
      return reply.send({
        ok: false,
        errorMessage: err instanceof Error ? err.message : String(err),
        answers: {},
        judgeId: '',
        latencyMs: Date.now() - started,
      });
    }
  });

  // Persist the judge section of config.yaml (hot reload handled by the
  // config watcher / onConfigSaved path other settings routes use).
  app.post('/api/judge/config', async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return reply
        .status(400)
        .send({ error: 'Bad Request', message: 'Body must be a JSON object' });
    }
    const parsed = judgeSectionSchema.safeParse(body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Invalid judge config',
        message: parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; '),
      });
    }
    // The WebUI only edits a subset (enabled/provider/modelRef/fallbackTiers/
    // modes); merge over the persisted section so hand-edited features,
    // timeout_ms, record_state and judges entries survive a UI save.
    // '' is the UI's "clear this optional field" sentinel — it must override
    // the current value (explicit undefined), not be deleted and re-inherited.
    const body_ = { ...body } as Record<string, unknown>;
    const cleared: Record<string, unknown> = {};
    for (const key of ['provider', 'modelRef'] as const) {
      if (body_[key] === '') {
        delete body_[key];
        cleared[key] = undefined;
      }
    }
    const currentCamel = (cfg.getConfig().judge ?? {}) as Record<string, unknown>;
    const merged = judgeSectionSchema.safeParse({
      ...currentCamel,
      ...body_,
      ...cleared,
    });
    if (!merged.success) {
      return reply.status(400).send({
        error: 'Invalid judge config',
        message: merged.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; '),
      });
    }
    try {
      await mutateConfigYaml((doc) => {
        const existing = readConfigObject(doc);
        existing.judge = judgeConfigToYaml(merged.data);
        applyConfigObject(doc, existing);
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: 'Internal Server Error', message });
    }

    if (cfg.onConfigSaved) {
      try {
        cfg.onConfigSaved(loadConfig());
      } catch (err) {
        app.log.warn({ err }, 'judge config saved but hot-reload failed');
      }
    }
    return reply.send({ ok: true, config: merged.data });
  });

  // Store ONE judge provider's credentials into config.yaml `provider_keys`.
  // Merge semantics (unlike PUT /api/config, which replaces the whole
  // provider_keys section) so the judge tab never drops other providers' keys.
  // YAML keys are snake_case (api_key/base_url/account_id, config.yaml
  // convention) — and the YAML-mapped shape is what other readers consume.
  // Per-field: non-empty string sets, '' clears, omitted leaves untouched.
  // An emptied provider entry (no api_key/base_url/account_id left) is deleted.
  app.post('/api/judge/key', async (request, reply) => {
    const body = request.body as
      { provider?: unknown; apiKey?: unknown; accountId?: unknown } | undefined;
    if (
      !body ||
      typeof body !== 'object' ||
      typeof body.provider !== 'string' ||
      body.provider.length === 0 ||
      (!('apiKey' in body && typeof body.apiKey === 'string') &&
        !('accountId' in body && typeof body.accountId === 'string'))
    ) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Expected { provider: string, apiKey?: string, accountId?: string }',
      });
    }
    const { provider } = body as { provider: string };
    const hasApiKey = 'apiKey' in body && typeof body.apiKey === 'string';
    const hasAccountId = 'accountId' in body && typeof body.accountId === 'string';
    try {
      await mutateConfigYaml((doc) => {
        const existing = readConfigObject(doc);
        const pk = {
          ...((existing.provider_keys ?? {}) as Record<string, Record<string, unknown>>),
        };
        // Normalize legacy camelCase spellings (old writers) to snake_case.
        const prior = (pk[provider] ?? {}) as Record<string, unknown>;
        const entry: Record<string, unknown> = {
          api_key: prior.api_key ?? prior.apiKey,
          base_url: prior.base_url ?? prior.baseUrl,
          account_id: prior.account_id ?? prior.accountId,
        };
        if (hasApiKey) {
          if (body.apiKey === '') delete entry.api_key;
          else entry.api_key = body.apiKey as string;
        }
        if (hasAccountId) {
          if (body.accountId === '') delete entry.account_id;
          else entry.account_id = body.accountId as string;
        }
        // '' is the clear sentinel: a field that is absent or empty counts as
        // gone. All three fields gone → the provider entry itself is deleted.
        const emptied = Object.values(entry).every((v) => v === undefined || v === '');
        if (emptied) {
          delete pk[provider];
        } else {
          for (const k of Object.keys(entry)) {
            if (entry[k] === undefined || entry[k] === '') delete entry[k];
          }
          pk[provider] = entry;
        }
        existing.provider_keys = pk;
        applyConfigObject(doc, existing);
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: 'Internal Server Error', message });
    }

    if (cfg.onConfigSaved) {
      try {
        cfg.onConfigSaved(loadConfig());
      } catch (err) {
        app.log.warn({ err }, 'judge key saved but hot-reload failed');
      }
    }
    return reply.send({ ok: true, keyStatus: buildKeyStatus(cfg.getConfig()) });
  });
}

/** Normalised camelCase judge section → snake_case config.yaml keys. */
function judgeConfigToYaml(j: NonNullable<AppConfig['judge']>): Record<string, unknown> {
  return {
    enabled: j.enabled,
    ...(j.provider !== undefined ? { provider: j.provider } : {}),
    ...(j.modelRef !== undefined ? { model_ref: j.modelRef } : {}),
    ...(j.fallbackTiers !== undefined ? { fallback_tiers: j.fallbackTiers } : {}),
    ...(j.chain !== undefined ? { chain: j.chain } : {}),
    ...(j.routes !== undefined ? { routes: j.routes } : {}),
    ...(j.modes !== undefined ? { modes: j.modes } : {}),
    ...(j.judges !== undefined
      ? {
          judges: Object.fromEntries(
            Object.entries(j.judges).map(([name, entry]) => [
              name,
              {
                type: entry.type,
                ...(entry.baseUrl !== undefined ? { base_url: entry.baseUrl } : {}),
                ...(entry.apiKeyEnv !== undefined ? { api_key_env: entry.apiKeyEnv } : {}),
                ...(entry.model !== undefined ? { model: entry.model } : {}),
              },
            ]),
          ),
        }
      : {}),
    ...(j.features !== undefined
      ? {
          features: {
            test_log_fold: j.features.testLogFold,
            admission: {
              chunk_size_chars: j.features.admission.chunkSizeChars,
              keep_threshold: j.features.admission.keepThreshold,
            },
          },
        }
      : {}),
    ...(j.timeoutMs !== undefined ? { timeout_ms: j.timeoutMs } : {}),
    ...(j.recordState !== undefined ? { record_state: j.recordState } : {}),
  };
}
