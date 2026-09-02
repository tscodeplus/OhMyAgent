import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createComputerUseServices } from '../../src/app/composers/computer-use-services.js';
import type { AppConfig } from '../../src/app/types.js';

// ---------------------------------------------------------------------------
// Run in a "Termux" environment: existsSync on any /data/data/com.termux path
// returns true, which makes the composer skip NutJS and prefer the node
// provider when configured.
// ---------------------------------------------------------------------------

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn((p: string) => p.includes('com.termux')),
  };
});

// The darwin:local provider probes availability by compiling and running the
// embedded Swift AX tool (swiftc). CI runners (ubuntu-latest, macOS) have
// swiftc, so a real probe can take 10s+ and blow the 10s test timeout. This
// is a composer unit test — mock the probe, keep everything else real.
vi.mock('../../src/computer-use/ssh-actions-darwin.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/computer-use/ssh-actions-darwin.js')>();
  return {
    ...actual,
    runSwiftAx: vi.fn(async () => ({ ok: true })),
  };
});

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
} as never;

function baseConfig(overrides?: Record<string, unknown>): AppConfig {
  return {
    computerUse: {
      enabled: true,
      provider: 'auto',
      allowedApps: [],
      allowedAgents: ['*'],
      approvalWhitelist: [],
      perPlatformProvider: {},
      ...overrides,
    },
  } as unknown as AppConfig;
}

describe('createComputerUseServices (Termux)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, data: {} }),
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers the node provider and uses it as default when node.url is configured', async () => {
    const services = await createComputerUseServices(
      baseConfig({ node: { url: 'http://127.0.0.1:8080' } }),
      noopLogger,
    );
    expect(services.computerUseHost).toBeDefined();
    const status = await services.computerUseHost!.getStatus({ sessionPath: '', agentId: '' });
    const ids = status.providers.map((p) => p.providerId);
    expect(ids).toContain('node');
    // Node is the default on Termux, so its status must be available.
    expect(status.providers.find((p) => p.providerId === 'node')?.available).toBe(true);
  });

  it('falls back to mock on Termux when node.url is not configured', async () => {
    const services = await createComputerUseServices(baseConfig(), noopLogger);
    expect(services.computerUseHost).toBeDefined();
    const status = await services.computerUseHost!.getStatus({ sessionPath: '', agentId: '' });
    const ids = status.providers.map((p) => p.providerId);
    expect(ids).not.toContain('node');
    expect(ids).toContain('mock');
  });

  it('returns no host when computer use is disabled', async () => {
    const services = await createComputerUseServices(baseConfig({ enabled: false }), noopLogger);
    expect(services.computerUseHost).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Native local providers (macOS / Linux, non-WSL, non-Termux). The module
// mock above makes existsSync match only com.termux paths; these tests
// re-mock it per-test so neither WSL nor Termux is detected.
// ---------------------------------------------------------------------------

describe('createComputerUseServices (native local providers)', () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

  afterEach(() => {
    if (realPlatform) {
      Object.defineProperty(process, 'platform', realPlatform);
    } else {
      delete (process as { platform?: string }).platform;
    }
  });

  async function setExistsSync(impl: (p: string) => boolean) {
    const { existsSync } = await import('node:fs');
    (existsSync as ReturnType<typeof vi.fn>).mockImplementation(impl);
  }

  afterEach(async () => {
    await setExistsSync((p: string) => p.includes('com.termux'));
  });

  async function mockNativeEnv() {
    await setExistsSync(() => false); // neither WSL interop nor Termux
  }

  it('registers darwin:local (JXA AX) on native macOS instead of NutJS', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    await mockNativeEnv();
    const services = await createComputerUseServices(baseConfig(), noopLogger);
    const status = await services.computerUseHost!.getStatus({ sessionPath: '', agentId: '' });
    const ids = status.providers.map((p) => p.providerId);
    expect(ids).toContain('darwin:local');
    expect(ids).not.toContain('nutjs');
  });

  it('registers linux:local (AT-SPI) on native Linux instead of NutJS', async () => {
    await mockNativeEnv();
    const services = await createComputerUseServices(baseConfig(), noopLogger);
    const status = await services.computerUseHost!.getStatus({ sessionPath: '', agentId: '' });
    const ids = status.providers.map((p) => p.providerId);
    expect(ids).toContain('linux:local');
    expect(ids).not.toContain('nutjs');
  });

  it('registers windows:local (UIA) on native Windows instead of NutJS', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    await mockNativeEnv();
    const services = await createComputerUseServices(baseConfig(), noopLogger);
    const status = await services.computerUseHost!.getStatus({ sessionPath: '', agentId: '' });
    const ids = status.providers.map((p) => p.providerId);
    expect(ids).toContain('windows:local');
    expect(ids).not.toContain('nutjs');
  });
});
