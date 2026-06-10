import type { SmartAgentTeamConfig } from '../app/types.js';

export interface TeamModeState {
  enabled: boolean;
  oneShot: boolean;
  config: SmartAgentTeamConfig;
}

const store = new Map<string, TeamModeState>();
let defaultConfig: SmartAgentTeamConfig | undefined;

export const teamModeStore = {
  /** Call once during bootstrap to inject the global default config. */
  init(config: SmartAgentTeamConfig): void {
    defaultConfig = config;
  },

  /** Hot reload: update the default config for new sessions. */
  updateConfig(config: SmartAgentTeamConfig): void {
    defaultConfig = config;
  },

  get(sessionId: string): TeamModeState | undefined {
    return store.get(sessionId);
  },

  isEnabled(sessionId: string): boolean {
    return store.get(sessionId)?.enabled ?? false;
  },

  enable(sessionId: string, oneShot = false): void {
    const config = defaultConfig ?? { enabled: true, max_children: 4 };
    store.set(sessionId, { enabled: true, oneShot, config });
  },

  disable(sessionId: string): void {
    const existing = store.get(sessionId);
    if (existing) {
      store.set(sessionId, { ...existing, enabled: false, oneShot: false });
    }
  },

  /** Set oneShot flag without changing enabled state. */
  markOneShot(sessionId: string): void {
    const existing = store.get(sessionId);
    if (existing) {
      store.set(sessionId, { ...existing, oneShot: true });
    }
  },

  delete(sessionId: string): void {
    store.delete(sessionId);
  },
};
