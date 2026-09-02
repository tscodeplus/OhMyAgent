// src/shared/agent-home.ts
//
// Single resolution point for the gateway's *data* root — everything the agent
// writes at runtime (downloads, chat uploads, attachments, screenshots, the
// download HMAC secret file).
//
// Before this existed each of those sites did `resolve(process.cwd(), 'data', …)`,
// which made the sandbox's writable scope depend on how the process happened to be
// launched: `pnpm dev` (repo root), systemd (unit's WorkingDirectory), Termux
// ($HOME), the Tauri sidecar (its own install directory — i.e. Program Files on
// Windows). The same config granted different write permissions in each.
//
// `OHMYAGENT_HOME` is now the explicit knob. When unset the fallback is cwd, which
// preserves the previous behaviour for deployments that never set it.
//
// Code-adjacent resources (`skills/`, `templates/`, `extensions/`) deliberately stay
// cwd-relative: the sidecar chdirs to the server root precisely so those resolve
// inside the installation, and moving them would orphan the bundled copies.

import path from 'node:path';

let cachedHome: string | null = null;

/**
 * The agent data root. Resolved once and cached, so a later `process.chdir()`
 * cannot relocate the writable plane underneath a running gateway.
 */
export function getAgentHome(): string {
  if (cachedHome !== null) return cachedHome;
  const fromEnv = process.env.OHMYAGENT_HOME?.trim();
  cachedHome = fromEnv ? path.resolve(fromEnv) : process.cwd();
  return cachedHome;
}

/** Absolute path inside {@link getAgentHome}. */
export function agentPath(...segments: string[]): string {
  return path.join(getAgentHome(), ...segments);
}

/** Absolute path inside `<agent home>/data`. */
export function dataPath(...segments: string[]): string {
  return agentPath('data', ...segments);
}

/** Drop the memoised value — for tests that vary `OHMYAGENT_HOME`/cwd. */
export function resetAgentHomeCache(): void {
  cachedHome = null;
}

/**
 * Turn a configured directory value into an absolute path.
 *
 * Config keeps these values relative (`./data/generated-images`) so a config
 * file stays portable across machines — but "relative to what" must not depend
 * on the launch directory, or the same config writes to and serves from
 * different places under Termux vs systemd vs the desktop sidecar. Relative
 * values therefore anchor to {@link getAgentHome}.
 */
export function resolveAgentPath(value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : agentPath(value);
}
