/**
 * Config persistence helper for WebUI.
 *
 * Extracted from bootstrap.ts. Persists in-memory config mutations (agent CRUD
 * etc.) to config.yaml. The file watcher only detects filesystem changes, not
 * in-memory mutations, so this callback ensures YAML stays in sync.
 *
 * The write goes through the shared serialised helper (yaml-mutation.ts) so it
 * cannot lose fields written concurrently by another config saver.
 */

import { existsSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { applyConfigObject, mutateConfigYaml, readConfigObject } from './yaml-mutation.js';

export function createOnConfigChanged(logger?: { error: (...args: any[]) => void }): () => void {
  return () => {
    const configPath = process.env.CONFIG_FILE || './config.yaml';
    if (!existsSync(configPath)) return;

    // Callers are synchronous (`onConfigChanged?.()`), so the queued write is
    // started here and its rejection is surfaced through the logger.
    mutateConfigYaml((doc) => {
      const existing = readConfigObject(doc);
      const config = loadConfig();

      // Persist agents: JS array → YAML map (id → {name, ...})
      if (config.agents && config.agents.length > 0) {
        const agentsMap: Record<string, unknown> = {};
        for (const agent of config.agents) {
          const { id, ...rest } = agent as unknown as Record<string, unknown>;
          agentsMap[id as string] = rest;
        }
        existing.agents = agentsMap;
      } else {
        delete existing.agents;
      }

      applyConfigObject(doc, existing);
    }).catch((err: unknown) => {
      logger?.error('[onConfigChanged] Failed to persist config:', err);
    });
  };
}
