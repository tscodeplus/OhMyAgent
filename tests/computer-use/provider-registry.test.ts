import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_PROVIDER_BY_PLATFORM,
  ComputerProviderRegistry,
  resolveComputerProviderId,
} from '../../src/computer-use/provider-registry.js';
import type { ComputerUseSettings } from '../../src/computer-use/settings.js';
import type { ComputerUseProvider } from '../../src/computer-use/provider-contract.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSettings(overrides?: Partial<ComputerUseSettings>): ComputerUseSettings {
  return {
    enabled: true,
    provider: 'auto',
    ssh: { host: '', user: '', keyPath: '', port: 22, jumpHost: '', display: ':0' },
    node: { url: '' },
    allowedApps: [],
    allowedAgents: [],
    approvalWhitelist: [],
    perPlatformProvider: { linux: '', win32: '', darwin: '' },
    ...overrides,
  };
}

function stubProvider(id: string): ComputerUseProvider {
  return { providerId: id } as ComputerUseProvider;
}

// ---------------------------------------------------------------------------
// DEFAULT_PROVIDER_BY_PLATFORM
// ---------------------------------------------------------------------------

describe('DEFAULT_PROVIDER_BY_PLATFORM', () => {
  it('maps linux, darwin, and win32 all to nutjs', () => {
    expect(DEFAULT_PROVIDER_BY_PLATFORM).toEqual({
      linux: 'nutjs',
      win32: 'nutjs',
      darwin: 'nutjs',
    });
  });
});

// ---------------------------------------------------------------------------
// resolveComputerProviderId
// ---------------------------------------------------------------------------

describe('resolveComputerProviderId', () => {
  it('explicit providerId takes priority over platform override and default', () => {
    const result = resolveComputerProviderId({
      explicitProviderId: 'ssh',
      settings: makeSettings({
        perPlatformProvider: { linux: 'nutjs', win32: '', darwin: '' },
      }),
      platform: 'linux',
      defaultProviderId: 'local',
      hasProvider: () => true,
    });
    expect(result).toBe('ssh');
  });

  it('per-platform env override has second priority', () => {
    const result = resolveComputerProviderId({
      explicitProviderId: null,
      settings: makeSettings({
        perPlatformProvider: { linux: 'ssh', win32: '', darwin: '' },
      }),
      platform: 'linux',
      defaultProviderId: 'local',
      hasProvider: (id: string) => id === 'ssh',
    });
    expect(result).toBe('ssh');
  });

  it('falls back to defaultProviderId when no provider matches', () => {
    const result = resolveComputerProviderId({
      explicitProviderId: null,
      settings: makeSettings(),
      platform: 'linux',
      defaultProviderId: 'ssh',
      hasProvider: () => false,
    });
    // Step 2: perPlatformProvider.linux = '' -> skipped
    // Step 3: DEFAULT_PROVIDER_BY_PLATFORM.linux = 'nutjs', hasProvider('nutjs') = false -> skipped
    // Step 4: return defaultProviderId = 'ssh'
    expect(result).toBe('ssh');
  });

  it('platform default (DEFAULT_PROVIDER_BY_PLATFORM) is used when no explicit or override', () => {
    const result = resolveComputerProviderId({
      explicitProviderId: null,
      settings: makeSettings(),
      platform: 'linux',
      defaultProviderId: 'local',
      hasProvider: (id: string) => id === 'nutjs',
    });
    expect(result).toBe('nutjs');
  });

  it('per-platform override is skipped when provider is not registered', () => {
    const result = resolveComputerProviderId({
      explicitProviderId: null,
      settings: makeSettings({
        perPlatformProvider: { linux: 'ssh', win32: '', darwin: '' },
      }),
      platform: 'linux',
      defaultProviderId: 'local',
      hasProvider: (id: string) => id === 'nutjs',
    });
    // Step 2: perPlatformProvider.linux = 'ssh', hasProvider('ssh') = false -> skipped
    // Step 3: DEFAULT_PROVIDER_BY_PLATFORM.linux = 'nutjs', hasProvider('nutjs') = true -> 'nutjs'
    expect(result).toBe('nutjs');
  });
});

// ---------------------------------------------------------------------------
// ComputerProviderRegistry
// ---------------------------------------------------------------------------

describe('ComputerProviderRegistry', () => {
  let registry: ComputerProviderRegistry;

  beforeEach(() => {
    registry = new ComputerProviderRegistry();
  });

  it('register and get a provider by id', () => {
    const provider = stubProvider('test-provider');
    registry.register(provider);
    expect(registry.get('test-provider')).toBe(provider);
  });

  it('get returns undefined for an unknown id', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('require returns the provider when registered', () => {
    const provider = stubProvider('my-provider');
    registry.register(provider);
    expect(registry.require('my-provider')).toBe(provider);
  });

  it('require throws PROVIDER_UNAVAILABLE when provider is not found', () => {
    expect(() => registry.require('missing')).toThrow(
      'Computer provider not found: missing',
    );
  });

  it('list returns all registered providers in registration order', () => {
    const p1 = stubProvider('p1');
    const p2 = stubProvider('p2');
    registry.register(p1);
    registry.register(p2);
    expect(registry.list()).toEqual([p1, p2]);
  });

  it('list returns empty array when no providers are registered', () => {
    expect(registry.list()).toEqual([]);
  });

  it('has returns true when the provider is registered', () => {
    registry.register(stubProvider('active-provider'));
    expect(registry.has('active-provider')).toBe(true);
  });

  it('has returns false when the provider is not registered', () => {
    expect(registry.has('missing')).toBe(false);
  });

  it('register can replace an existing provider with the same id', () => {
    const original = stubProvider('dup');
    const replacement = stubProvider('dup');
    registry.register(original);
    registry.register(replacement);
    expect(registry.get('dup')).toBe(replacement);
  });
});
