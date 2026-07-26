/**
 * ConfigManager — unified configuration hot-reload manager.
 *
 * Replaces ad-hoc config-event handling with a two-phase reload protocol:
 *   1. Validate phase: all registered services validate the new config.
 *      If any validation fails, the reload is aborted with detailed errors.
 *   2. Apply phase: all registered services apply the new config in
 *      registration order, with per-service success/failure tracking.
 *
 * Backward-compatible with ConfigEventBus: after its own two-phase cycle,
 * ConfigManager fires configEventBus.emit() so services still using the
 * old onReload pattern continue to work without migration.
 *
 * Usage:
 *   const mgr = new ConfigManager();
 *   mgr.setLogger(logger);
 *   mgr.registerService('my-service', {
 *     validate: async (c) => { if (!c.piAi.apiKey) throw new Error('no API key'); },
 *     apply:    async (c) => { myService.update(c); },
 *   });
 *   const result = await mgr.reload(newConfig);
 */

import { configEventBus } from './config-event-bus.js';
import { resetConfig, loadConfig } from './config.js';
import type { AppConfig } from './types.js';

// ─── Types ───

export interface ServiceHooks {
  /**
   * Optional validation hook. Called during the validate phase.
   * Throw an error (or return a rejected promise) to signal that
   * the config is invalid for this service and abort the reload.
   */
  validate?: (config: AppConfig) => Promise<void>;
  /**
   * Required apply hook. Called during the apply phase, only after
   * ALL registered services have passed validation.
   * Errors are caught and reported individually — one failing service
   * does not block others from applying.
   */
  apply: (config: AppConfig) => Promise<void>;
}

interface RegisteredService {
  name: string;
  hooks: ServiceHooks;
}

export interface ReloadResult {
  /** True when all services validated and applied without error. */
  success: boolean;
  /** Human-readable error messages grouped by service and phase. */
  errors: string[];
  /** Names of services that successfully completed the apply phase. */
  applied: string[];
  /** Names of services that threw during the apply phase. */
  failed: string[];
}

// ─── ConfigManager ───

export class ConfigManager {
  private services: RegisteredService[] = [];
  private logger?: { error: (...args: any[]) => void };

  setLogger(logger: { error: (...args: any[]) => void }): void {
    this.logger = logger;
  }

  /**
   * Register a service's config reload hooks.
   *
   * Services are applied in registration order during the apply phase.
   * This order is significant when services have implicit dependencies
   * (e.g., policy must be updated before the tools that depend on it).
   *
   * @param name  Unique service name (used in error messages and result tracking).
   * @param hooks  validate (optional) and apply (required) hooks.
   */
  registerService(name: string, hooks: ServiceHooks): void {
    this.services.push({ name, hooks });
  }

  /**
   * Convenience method for backward-compatible one-shot reload handlers.
   * Delegates directly to the underlying ConfigEventBus, so these handlers
   * run _after_ all ConfigManager-registered service hooks during reload().
   *
   * Returns an unsubscribe function.
   */
  onReload(handler: (config: AppConfig) => void | Promise<void>): () => void {
    return configEventBus.onReload(handler);
  }

  /**
   * Two-phase config reload:
   *
   * 1. Validate — all registered services' `validate` hooks run sequentially.
   *    If any hook throws, the reload is aborted and no `apply` hooks run.
   *
   * 2. Apply — all registered services' `apply` hooks run in registration
   *    order. Each service's success or failure is tracked independently.
   *    A failure in one service does not block others from applying.
   *
   * After both phases complete, configEventBus.emit() is called for
   * backward compatibility with services still using the old onReload
   * pattern.
   */
  async reload(newConfig: AppConfig): Promise<ReloadResult> {
    const errors: string[] = [];
    const applied: string[] = [];
    const failed: string[] = [];

    // ── Phase 1: Validate ────────────────────────────────────────────
    // All hooks must pass; the first failure aborts subsequent validations
    // (fail-fast on validation — there is no point validating service B
    // when service A's config is already invalid).
    for (const svc of this.services) {
      if (svc.hooks.validate) {
        try {
          await svc.hooks.validate(newConfig);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`[${svc.name}] validate: ${msg}`);
          break; // fail-fast: one validate failure aborts the reload
        }
      }
    }

    // If any validation failed, abort — no apply phase
    if (errors.length > 0) {
      return { success: false, errors, applied, failed };
    }

    // ── Phase 2: Apply ───────────────────────────────────────────────
    // Run all apply hooks sequentially in registration order.
    // Individual failures are collected but do not block other services.
    for (const svc of this.services) {
      try {
        await svc.hooks.apply(newConfig);
        applied.push(svc.name);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`[${svc.name}] apply: ${msg}`);
        failed.push(svc.name);
        this.logger?.error(
          { service: svc.name, err },
          '[config-manager] Service apply hook failed',
        );
      }
    }

    // ── Phase 3: Legacy compat ───────────────────────────────────────
    // Fire configEventBus for services still using the old onReload
    // pattern (composers, etc.). This ensures a smooth migration path.
    try {
      await configEventBus.emit(newConfig);
    } catch (err) {
      this.logger?.error('[config-manager] configEventBus.emit failed:', err);
    }

    return { success: errors.length === 0, errors, applied, failed };
  }

  /**
   * Convenience: reset the config cache, reload from file, and run the
   * two-phase reload. Useful for WebUI config-save handlers and slash
   * commands that modify config.yaml directly.
   *
   * @param env       Optional environment overrides (defaults to process.env).
   * @param configPath  Optional config path (defaults to CONFIG_FILE env or ./config.yaml).
   */
  async reloadFromFile(
    env?: Record<string, string | undefined>,
    configPath?: string,
  ): Promise<ReloadResult> {
    resetConfig();
    const newConfig = loadConfig(env, configPath);
    return this.reload(newConfig);
  }
}

/**
 * Global singleton — used in bootstrap.ts and by triggerConfigReload
 * call sites (feishu-services, webui-routes, config-routes) so they
 * share the same registered service hooks.
 */
export const configManager = new ConfigManager();
