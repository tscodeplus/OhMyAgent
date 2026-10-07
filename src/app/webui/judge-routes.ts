/**
 * Judge kernel API routes (MyDocs/JEV_JUDGE_KERNEL_IMPLEMENTATION.md §5.5).
 *
 * GET  /api/judge/config — effective judge section + per-provider key status
 *                          + classifier model catalog grouped by provider.
 * GET  /api/judge/status — enabled flag, decision-point mode table, recent
 *                          ledger entries, circuit-breaker states.
 * POST /api/judge/test   — one golden sample (choice/noul/score) through the
 *                          live engine; judge-side problems never become 500s.
 * POST /api/judge/config — persist the judge section of config.yaml.
 */

import type { FastifyInstance } from 'fastify';
import { getModels } from '@earendil-works/pi-ai';
import { getModelType } from '@earendil-works/pi-ai';
import { judgeSectionSchema, loadConfig } from '../config.js';
import type { AppConfig, AppServices } from '../types.js';
import { DECISION_POINT_IDS } from '../../judge/decisions/registry.js';
import { goldenSampleSpec, GOLDEN_SAMPLE_STATE } from '../../judge/golden-sample.js';
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

export function registerJudgeRoutes(app: FastifyInstance, cfg: JudgeRouteConfig): void {
  // Effective judge section + provider key status + classifier model catalog.
  app.get('/api/judge/config', async (_request, reply) => {
    const config = judgeSectionSchema.parse(cfg.getConfig().judge ?? {});
    const appConfig = cfg.getConfig();

    const keyStatus: Record<
      string,
      { envVars: string[]; present: boolean; fromConfig: boolean; envPresent: boolean }
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
      keyStatus[provider] = {
        envVars: [...envVars],
        fromConfig,
        envPresent,
        present: fromConfig || envPresent || provider === 'opencode',
      };
    }

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

  // One golden sample through the live engine. Judge-side problems are
  // returned in-band, never as a 500.
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
}

/** Normalised camelCase judge section → snake_case config.yaml keys. */
function judgeConfigToYaml(j: NonNullable<AppConfig['judge']>): Record<string, unknown> {
  return {
    enabled: j.enabled,
    ...(j.provider !== undefined ? { provider: j.provider } : {}),
    ...(j.modelRef !== undefined ? { model_ref: j.modelRef } : {}),
    ...(j.fallbackTiers !== undefined ? { fallback_tiers: j.fallbackTiers } : {}),
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
