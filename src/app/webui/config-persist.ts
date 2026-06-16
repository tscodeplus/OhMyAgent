/**
 * Config persistence helper for WebUI.
 *
 * Extracted from bootstrap.ts. Persists in-memory config mutations (agent CRUD
 * etc.) to config.yaml. The file watcher only detects filesystem changes, not
 * in-memory mutations, so this callback ensures YAML stays in sync.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { load as parseYaml, dump as dumpYaml } from 'js-yaml';
import { loadConfig, resetConfig } from '../config.js';

export function createOnConfigChanged(): () => void {
  return () => {
    const configPath = process.env.CONFIG_FILE || './config.yaml';
    if (!existsSync(configPath)) return;
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const yaml = parseYaml(raw) as Record<string, unknown>;
      const config = loadConfig();

      // Persist agents: JS array → YAML map (id → {name, ...})
      if (config.agents && config.agents.length > 0) {
        const agentsMap: Record<string, unknown> = {};
        for (const agent of config.agents) {
          const { id, ...rest } = agent as unknown as Record<string, unknown>;
          agentsMap[id as string] = rest;
        }
        yaml.agents = agentsMap;
      } else {
        delete yaml.agents;
      }

      writeFileSync(configPath, dumpYaml(yaml, { indent: 2, lineWidth: 120 }), 'utf-8');
      resetConfig();
    } catch (err) {
      console.error('[onConfigChanged] Failed to persist config:', err);
    }
  };
}
