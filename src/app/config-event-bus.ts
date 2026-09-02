/**
 * ConfigEventBus — pub/sub for configuration reload notifications.
 *
 * Replaces the monolithic onConfigReload closure in bootstrap.ts with
 * self-registered listeners. Services subscribe to 'config:reload' at
 * construction time, so adding a new config-aware service no longer
 * requires modifying the bootstrap hot-reload chain.
 */

import type { AppConfig } from './types.js';

type ReloadHandler = (config: AppConfig) => void | Promise<void>;

class ConfigEventBus {
  private handlers = new Set<ReloadHandler>();
  private logger?: { error: (...args: any[]) => void };

  setLogger(logger: { error: (...args: any[]) => void }): void {
    this.logger = logger;
  }

  /**
   * Register a handler that fires on every config reload.
   * Returns an unsubscribe function.
   *
   * Errors thrown by individual handlers are caught by emit(),
   * so a single broken handler won't break the reload chain.
   */
  onReload(handler: ReloadHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Emit the new config to all registered handlers.
   * Each handler runs independently; failures are logged but
   * never propagated (one broken handler must not block others).
   */
  async emit(config: AppConfig): Promise<void> {
    // Snapshot: a handler may unsubscribe (or register) while running.
    const results = await Promise.allSettled(
      Array.from(this.handlers).map((handler) => Promise.resolve(handler(config))),
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        this.logger?.error('[config-event-bus] handler failed:', r.reason);
      }
    }
  }
}

export const configEventBus = new ConfigEventBus();
