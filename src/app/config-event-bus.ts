/**
 * ConfigEventBus — pub/sub for configuration reload notifications.
 *
 * Replaces the monolithic onConfigReload closure in bootstrap.ts with
 * self-registered listeners. Services subscribe to 'config:reload' at
 * construction time, so adding a new config-aware service no longer
 * requires modifying the bootstrap hot-reload chain.
 *
 * Pattern borrowed from PendingApprovalStore (src/agent/approval-store.ts)
 * which uses Node's EventEmitter for one-shot approval decisions.
 */

import { EventEmitter } from 'node:events';
import type { AppConfig } from './types.js';

const CONFIG_RELOAD_EVENT = 'config:reload';

class ConfigEventBus {
  private emitter = new EventEmitter();
  private logger?: { error: (...args: any[]) => void };

  constructor() {
    this.emitter.setMaxListeners(50);
  }

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
  onReload(handler: (config: AppConfig) => void | Promise<void>): () => void {
    this.emitter.on(CONFIG_RELOAD_EVENT, handler);
    return () => {
      this.emitter.off(CONFIG_RELOAD_EVENT, handler);
    };
  }

  /**
   * Emit the new config to all registered handlers.
   * Each handler runs independently; failures are logged but
   * never propagated (one broken handler must not block others).
   */
  async emit(config: AppConfig): Promise<void> {
    const listeners = this.emitter.listeners(CONFIG_RELOAD_EVENT);
    const results = await Promise.allSettled(
      listeners.map((fn) =>
        Promise.resolve((fn as (config: AppConfig) => void | Promise<void>)(config)),
      ),
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        this.logger?.error('[config-event-bus] handler failed:', r.reason);
      }
    }
  }
}

export const configEventBus = new ConfigEventBus();
