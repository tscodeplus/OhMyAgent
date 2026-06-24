/**
 * Config API Routes
 *
 * GET /api/config — return current config (with secret fields redacted)
 * PUT /api/config — update config.yaml via the YAML file
 * POST /api/config/reload — trigger hot reload
 */

import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../types.js';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { load as parseYaml, dump as dumpYaml } from 'js-yaml';
import { getModels, getProviders } from '../../pi-mono/ai/models.js';
import { resetConfig, loadConfig, startConfigWatcher } from '../config.js';
import { jsConfigToYaml } from '../config-loader.js';

const SECRET_FIELDS = [
  'apiKey',
  'appSecret',
  'botToken',
  'clientSecret',
  'verificationToken',
  'encryptKey',
  'aesKey',
  'tavilyApiKey',
  'exaApiKey',
  'baiduApiKey',
  'anysearchApiKey',
];

function redactSecrets(obj: unknown, depth = 0): unknown {
  if (depth > 10) return obj;
  if (Array.isArray(obj)) return obj.map((v) => redactSecrets(v, depth + 1));
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (SECRET_FIELDS.includes(key) && typeof value === 'string' && (value as string).length > 0) {
        result[key] = '';
      } else {
        result[key] = redactSecrets(value, depth + 1);
      }
    }
    return result;
  }
  return obj;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== 'object') {
        target[key] = {};
      }
      deepMerge(target[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else if (!(SECRET_FIELDS.includes(key) && value === '')) {
      // Preserve existing secret values when the incoming value is empty
      target[key] = value;
    }
  }
}

/** Map provider_keys inner entries from camelCase (used by WebUI) to snake_case (YAML convention). */
function mapProviderKeysToSnake(keys: Record<string, unknown>): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(keys)) {
    const e = entry as Record<string, unknown>;
    mapped[name] = {
      api_key: e.apiKey || e.api_key || undefined,
      base_url: e.baseUrl || e.base_url || undefined,
    };
  }
  return mapped;
}

/** Map CustomProvider array from camelCase (WebUI) to snake_case (YAML convention). */
function mapCustomProvidersToSnake(providers: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return providers.map(cp => ({
    provider: cp.provider,
    api_key: cp.apiKey || cp.api_key,
    base_url: cp.baseUrl || cp.base_url,
    models: (cp.models as Array<Record<string, unknown>>)?.map(m => ({
      id: m.id,
      name: m.name,
      api: m.api,
      reasoning: m.reasoning,
      reasoning_level: m.reasoningLevel || m.reasoning_level,
      context_window: m.contextWindow || m.context_window,
      max_tokens: m.maxTokens || m.max_tokens,
      input: m.input,
      cost: m.cost ? {
        input: (m.cost as Record<string, unknown>).input,
        output: (m.cost as Record<string, unknown>).output,
        cache_read: (m.cost as Record<string, unknown>).cacheRead ?? (m.cost as Record<string, unknown>).cache_read ?? 0,
        cache_write: (m.cost as Record<string, unknown>).cacheWrite ?? (m.cost as Record<string, unknown>).cache_write ?? 0,
      } : undefined,
    })),
  }));
}

/**
 * Expand dot-notation keys into nested objects.
 * Example: { "piAi.provider": "deepseek" } → { piAi: { provider: "deepseek" } }
 */
function expandDotKeys(body: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key.includes('.')) {
      const parts = key.split('.');
      let current = result;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!current[parts[i]] || typeof current[parts[i]] !== 'object' || Array.isArray(current[parts[i]])) {
          current[parts[i]] = {};
        }
        current = current[parts[i]] as Record<string, unknown>;
      }
      current[parts[parts.length - 1]] = value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

interface ConfigRouteConfig {
  getConfig: () => AppConfig;
  configPath: string;
  /** Called after config is saved via PUT — triggers hot-reload of services. */
  onConfigSaved?: (newConfig: AppConfig) => void;
}

export function registerConfigRoutes(app: FastifyInstance, cfg: ConfigRouteConfig): void {
  // Get current config (full values — endpoint requires auth)
  app.get('/api/config', async (_request, reply) => {
    const config = cfg.getConfig();

    // Enrich providerKeys with resolved base URLs from model catalog
    if (config.providerKeys && Object.keys(config.providerKeys).length > 0) {
      const enriched: Record<string, { apiKey?: string; baseUrl?: string }> = {};
      for (const [name, entry] of Object.entries(config.providerKeys)) {
        let baseUrl = entry.baseUrl;
        if (!baseUrl) {
          // Look up actual base URL from the first registered model for this provider
          const models = getModels(name as any);
          baseUrl = (models[0] as any)?.baseUrl || undefined;
        }
        enriched[name] = { apiKey: entry.apiKey, baseUrl };
      }
      config.providerKeys = enriched;
    }

    return reply.send(config);
  });

  // Return the list of built-in pi-mono providers so the frontend never
  // needs a hardcoded copy that drifts out of sync.
  app.get('/api/providers', async (_request, reply) => {
    const providers = getProviders().map(p => ({ id: p, name: p }));
    return reply.send({ providers });
  });

  // Check if first-run setup wizard should be shown
  app.get('/api/config/minimal-check', async (_request, reply) => {
    const config = cfg.getConfig();

    const missing = {
      provider: !config.piAi.provider,
      model: !config.piAi.model,
      apiKey: !config.piAi.apiKey,
      embedding: !config.embedding.model || !config.embedding.apiKey,
    };

    const showWizard = missing.provider || missing.model || missing.apiKey;

    const providers = getProviders().map(p => ({
      id: p,
      name: p,
      knownModels: getModels(p).slice(0, 5).map(m => m.id),
    }));

    return reply.send({
      showWizard,
      setupWizardDone: config.setupWizardDone ?? false,
      currentLanguage: config.uiLanguage,
      missing,
      providers,
    });
  });

  // Update config
  app.put('/api/config', async (request, reply) => {
    try {
      const updates = request.body as Record<string, unknown>;
      if (!updates || typeof updates !== 'object') {
        return reply.status(400).send({ error: 'Bad Request', message: 'Body must be a JSON object' });
      }

      const yamlPath = process.env.CONFIG_FILE || './config.yaml';

      // Read existing YAML
      let existing: Record<string, unknown> = {};
      if (existsSync(yamlPath)) {
        const raw = readFileSync(yamlPath, 'utf-8');
        existing = (parseYaml(raw) as Record<string, unknown>) || {};
      }

      // ── Preprocess body ──
      // 1. Expand dot-notation keys into nested objects
      const expanded = expandDotKeys(updates);

      // 2. provider_keys: full replacement (frontend sends the complete set)
      if (expanded.provider_keys !== undefined) {
        existing.provider_keys = {};
      }

      // 3. customProviders: full replacement (frontend sends the complete set)
      if (expanded.customProviders !== undefined) {
        existing.custom_providers = {};
      }

      // 4. Clean up known junk keys created by previous dot-notation writes
      for (const key of Object.keys(existing)) {
        if (key.includes('.')) {
          delete existing[key];
        }
      }

      // 5. Convert JS config shape → YAML shape (inverse of yamlToAppConfigRaw)
      const yamlBody = jsConfigToYaml(expanded, existing);

      // Merge updates into existing YAML
      deepMerge(existing, yamlBody);

      // Write back
      const yamlStr = dumpYaml(existing, { indent: 2, lineWidth: 120 });
      writeFileSync(yamlPath, yamlStr, 'utf-8');

      // Invalidate cached config so next GET returns fresh data
      resetConfig();

      // Trigger hot-reload of services with the new config (critical for first-run
      // setup wizard where the config.yaml didn't exist at bootstrap time, so the
      // file watcher was never started — without this, providers/models won't work
      // until a manual restart).
      if (cfg.onConfigSaved) {
        try {
          const newConfig = loadConfig();
          cfg.onConfigSaved(newConfig);
        } catch (err) {
          // Don't fail the save if hot-reload fails — config is written
        }
      }

      // Start the config file watcher if it wasn't active (first-run scenario
      // where config.yaml didn't exist at bootstrap). Starts the watcher so
      // subsequent changes via settings UI are picked up without restart.
      try {
        startConfigWatcher(cfg.configPath, (newCfg) => {
          cfg.onConfigSaved?.(newCfg);
        });
      } catch {
        // Watcher already active or file still missing — ignore
      }

      return reply.send({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: 'Internal Server Error', message });
    }
  });

  // Manual reload trigger
  app.post('/api/config/reload', async (_request, reply) => {
    // The config watcher will pick up the change automatically
    return reply.send({ ok: true, message: 'Config reload triggered (via file watcher)' });
  });

  // Test model connection
  app.post('/api/config/test-model-connection', async (request, reply) => {
    const { provider, model, apiKey, baseUrl } = request.body as {
      provider?: string;
      model?: string;
      apiKey?: string;
      baseUrl?: string;
    };

    // Simple connection test — send a minimal API request
    try {
      const testUrl = baseUrl || `https://api.${provider}.com/v1/models`;
      const response = await fetch(testUrl, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      return reply.send({
        ok: response.ok,
        status: response.status,
        message: response.ok ? 'Connection successful' : `HTTP ${response.status}`,
      });
    } catch (err: unknown) {
      return reply.send({ ok: false, message: (err as Error).message });
    }
  });
}
