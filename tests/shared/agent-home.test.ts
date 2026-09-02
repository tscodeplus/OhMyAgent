/**
 * Tests for the explicit agent data root (review P1 #4).
 *
 * Before this, every runtime-write directory was `resolve(process.cwd(), 'data', …)`,
 * so the sandbox's writable scope followed the launch directory: repo root under
 * `pnpm dev`, `$HOME` under Termux, the *install* directory for the desktop
 * sidecar (Program Files on Windows). OHMYAGENT_HOME makes that a single,
 * declared knob; these tests pin its precedence, its cwd fallback and the fact
 * that it is frozen once resolved.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join, resolve } from 'node:path';
import {
  getAgentHome,
  agentPath,
  dataPath,
  resolveAgentPath,
  resetAgentHomeCache,
} from '../../src/shared/agent-home.js';

const ORIGINAL_HOME = process.env.OHMYAGENT_HOME;

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.OHMYAGENT_HOME;
  else process.env.OHMYAGENT_HOME = ORIGINAL_HOME;
  resetAgentHomeCache();
});

describe('getAgentHome', () => {
  it('prefers OHMYAGENT_HOME', () => {
    process.env.OHMYAGENT_HOME = '/opt/oma';
    resetAgentHomeCache();
    expect(getAgentHome()).toBe(resolve('/opt/oma'));
  });

  it('treats a blank OHMYAGENT_HOME as unset', () => {
    process.env.OHMYAGENT_HOME = '   ';
    resetAgentHomeCache();
    expect(getAgentHome()).toBe(process.cwd());
  });

  it('falls back to the launch directory when unset', () => {
    delete process.env.OHMYAGENT_HOME;
    resetAgentHomeCache();
    expect(getAgentHome()).toBe(process.cwd());
  });

  it('is frozen until reset, so a mid-run change cannot relocate the data plane', () => {
    delete process.env.OHMYAGENT_HOME;
    resetAgentHomeCache();
    const atStartup = getAgentHome();

    process.env.OHMYAGENT_HOME = '/opt/oma';
    expect(getAgentHome()).toBe(atStartup);

    resetAgentHomeCache();
    expect(getAgentHome()).toBe(resolve('/opt/oma'));
  });
});

describe('agentPath / dataPath', () => {
  it('joins under the agent home', () => {
    process.env.OHMYAGENT_HOME = '/opt/oma';
    resetAgentHomeCache();
    const home = resolve('/opt/oma');
    expect(agentPath('templates', 'x.md')).toBe(join(home, 'templates', 'x.md'));
    expect(dataPath('downloads')).toBe(join(home, 'data', 'downloads'));
  });
});

describe('resolveAgentPath', () => {
  it('anchors relative config values to the agent home, not to cwd', () => {
    process.env.OHMYAGENT_HOME = '/opt/oma';
    resetAgentHomeCache();
    expect(resolveAgentPath('./data/generated-images')).toBe(dataPath('generated-images'));
  });

  it('keeps absolute config values as written', () => {
    process.env.OHMYAGENT_HOME = '/opt/oma';
    resetAgentHomeCache();
    expect(resolveAgentPath(resolve('/srv/media'))).toBe(resolve('/srv/media'));
  });
});
