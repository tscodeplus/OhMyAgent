import { describe, it, expect } from 'vitest';
import { ComputerUseHost } from '../../src/computer-use/computer-host';
import { ComputerProviderRegistry } from '../../src/computer-use/provider-registry';
import { ComputerLeaseRegistry } from '../../src/computer-use/lease-registry';
import { createMockComputerProvider } from '../../src/computer-use/providers/mock-provider';
import { normalizeComputerUseSettings } from '../../src/computer-use/settings';
import type { Ctx } from '../../src/computer-use/types';
import type { ComputerUseProvider } from '../../src/computer-use/provider-contract';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseCtx: Ctx = {
  sessionPath: 'sess-1',
  agentId: 'agent-1',
  model: { provider: 'test', id: 'test-model', input: ['image'] },
};

interface TestHarness {
  host: ComputerUseHost;
  providerRegistry: ComputerProviderRegistry;
  leaseRegistry: ComputerLeaseRegistry;
  mockProvider: ReturnType<typeof createMockComputerProvider>;
}

function createTestHost(overrides?: {
  enabled?: boolean;
  allowedApps?: string[];
  allowedAgents?: string[];
}): TestHarness {
  const providerRegistry = new ComputerProviderRegistry();
  const mockProvider = createMockComputerProvider();
  providerRegistry.register(mockProvider);

  const leaseRegistry = new ComputerLeaseRegistry();
  const settings = normalizeComputerUseSettings();

  const host = new ComputerUseHost({
    providers: providerRegistry,
    defaultProviderId: 'mock',
    leases: leaseRegistry,
    platform: 'linux',
    getSettings: () => ({
      ...settings,
      enabled: overrides?.enabled ?? true,
      allowedApps: overrides?.allowedApps ?? ['app.notes'],
      allowedAgents: overrides?.allowedAgents ?? [],
    }),
  });

  return { host, providerRegistry, leaseRegistry, mockProvider };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ComputerUseHost', () => {
  // -----------------------------------------------------------------------
  // Happy path
  // -----------------------------------------------------------------------

  describe('happy path', () => {
    it('creates a lease, gets app state, performs actions, and releases', async () => {
      const { host, mockProvider } = createTestHost();

      // Create lease
      const lease = await host.createLease(baseCtx, { appName: 'app.notes' });
      expect(lease.status).toBe('active');
      expect(lease.appId).toBe('app.notes');

      // Get app state — should include screenshot, elements, and a snapshotId
      const state = await host.getAppState(baseCtx, lease.leaseId);
      expect(state.screenshot).toBeDefined();
      expect(state.screenshot!.data).toBeTruthy();
      expect(state.elements).toHaveLength(2);
      expect(state.elements[0].elementId).toBe('mock-button');
      expect(state.elements[1].elementId).toBe('mock-input');
      expect(state.snapshotId).toBeDefined();
      expect(state.leaseId).toBe(lease.leaseId);

      // Click element
      const clickResult = await host.performAction(baseCtx, lease.leaseId, {
        type: 'click_element',
        elementId: 'mock-button',
      });
      expect(clickResult.ok).toBe(true);
      expect(clickResult.action).toBe('click_element');
      expect(mockProvider.actions.at(-1)?.action.snapshotElement).toMatchObject({
        elementId: 'mock-button',
        bounds: { x: 100, y: 120, width: 160, height: 44 },
      });

      // Type text
      const typeResult = await host.performAction(baseCtx, lease.leaseId, {
        type: 'type_text',
        text: 'hello world',
      });
      expect(typeResult.ok).toBe(true);
      expect(typeResult.action).toBe('type_text');

      // Release lease
      const released = await host.releaseLease(baseCtx, lease.leaseId);
      expect(released).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Disabled
  // -----------------------------------------------------------------------

  describe('disabled', () => {
    it('throws DISABLED when Computer Use is globally disabled', async () => {
      const { host } = createTestHost({ enabled: false });

      await expect(
        host.createLease(baseCtx, { appName: 'app.notes' }),
      ).rejects.toThrow('Computer Use is globally disabled');
    });
  });

  describe('runtime context', () => {
    it('throws DISABLED when ctx accessMode is read-only', async () => {
      const { host } = createTestHost();

      await expect(
        host.createLease({ ...baseCtx, accessMode: 'read-only' }, { appName: 'app.notes' }),
      ).rejects.toThrow('Computer Use unavailable in read-only sessions');
    });

    it('allows configured non-primary agents to use Computer Use', async () => {
      const { host } = createTestHost({ allowedAgents: ['agent-2'] });
      const lease = await host.createLease(
        { ...baseCtx, agentId: 'agent-2' },
        { appName: 'app.notes' },
      );

      expect(lease.agentId).toBe('agent-2');
    });

    it('rejects agents that are not in allowedAgents', async () => {
      const { host } = createTestHost({ allowedAgents: ['agent-2'] });

      await expect(
        host.createLease(baseCtx, { appName: 'app.notes' }),
      ).rejects.toThrow('This agent is not allowed to use Computer Use');
    });
  });

  // -----------------------------------------------------------------------
  // Model not supported
  // -----------------------------------------------------------------------

  describe('model without image support', () => {
    it('allows Computer Use for text-only models (screenshot is optional)', async () => {
      const { host } = createTestHost();
      const textOnlyCtx: Ctx = {
        ...baseCtx,
        model: { provider: 'test', id: 'test-model', input: ['text'] },
      };

      // Text-only models can still use Computer Use via element tree
      const lease = await host.createLease(textOnlyCtx, { appName: 'app.notes' });
      expect(lease.appId).toBe('app.notes');
      expect(lease.leaseId).toBe('mock-lease-1');
    });
  });

  // -----------------------------------------------------------------------
  // App not in whitelist
  // -----------------------------------------------------------------------

  describe('app not in whitelist', () => {
    it('matches localized app approval aliases against canonical app ids', async () => {
      const { host, providerRegistry } = createTestHost({
        allowedApps: [],
      });
      const nonIsolatedMock = createMockComputerProvider({
        providerId: 'non-isolated',
      });
      nonIsolatedMock.capabilities = {
        ...nonIsolatedMock.capabilities,
        isolated: false,
      };
      providerRegistry.register(nonIsolatedMock as ComputerUseProvider);

      host.approveApp(baseCtx, '记事本');

      await expect(
        host.createLease(baseCtx, {
          appName: 'notepad',
          providerId: 'non-isolated',
        }),
      ).resolves.toMatchObject({ providerId: 'non-isolated' });
    });

    it('throws APP_APPROVAL_REQUIRED for a non-isolated provider', async () => {
      const { host, providerRegistry } = createTestHost({
        allowedApps: ['app.notes'],
      });

      // Register a second provider that is NOT isolated so the app approval
      // check is actually enforced.
      const nonIsolatedMock = createMockComputerProvider({
        providerId: 'non-isolated',
      });
      nonIsolatedMock.capabilities = {
        ...nonIsolatedMock.capabilities,
        isolated: false,
      };
      providerRegistry.register(nonIsolatedMock as ComputerUseProvider);

      await expect(
        host.createLease(baseCtx, {
          appName: 'forbidden-app',
          providerId: 'non-isolated',
        }),
      ).rejects.toThrow('App requires approval before control');
    });
  });

  // -----------------------------------------------------------------------
  // Capability unsupported
  // -----------------------------------------------------------------------

  describe('capability unsupported', () => {
    it('allows foreground input capabilities after the app lease is approved', async () => {
      const { host, providerRegistry } = createTestHost();
      const foregroundProvider = createMockComputerProvider({ providerId: 'foreground' });
      providerRegistry.register({
        ...foregroundProvider,
        capabilities: {
          ...foregroundProvider.capabilities,
          textInput: 'foreground',
          keyboardInput: 'foreground',
          isolated: false,
        },
      } as ComputerUseProvider);

      host.approveApp(baseCtx, 'app.notes');
      const lease = await host.createLease(
        baseCtx,
        { appName: 'app.notes', providerId: 'foreground' },
      );

      await expect(
        host.performAction(baseCtx, lease.leaseId, {
          type: 'type_text',
          text: '你好',
        }),
      ).resolves.toMatchObject({ ok: true, action: 'type_text' });
    });

    it('throws CAPABILITY_UNSUPPORTED for an unsupported action type', async () => {
      const { host, providerRegistry } = createTestHost();

      // Create a provider that allows double_click in the lease policy but
      // has elementDoubleClick: false so the capability check fails.
      const limited = createMockComputerProvider({ providerId: 'limited' });
      const origCreateLease = limited.createLease;
      const limitedProvider: ComputerUseProvider = {
        ...limited,
        capabilities: { ...limited.capabilities, elementDoubleClick: false },
        async createLease(ctx, target) {
          const base = await origCreateLease(ctx, target);
          return { ...base, allowedActions: [...base.allowedActions, 'double_click'] };
        },
      };
      providerRegistry.register(limitedProvider);

      const lease = await host.createLease(
        baseCtx,
        { appName: 'app.notes', providerId: 'limited' },
      );

      await expect(
        host.performAction(baseCtx, lease.leaseId, {
          type: 'double_click',
          elementId: 'mock-button',
        }),
      ).rejects.toThrow('Provider does not support this action');
    });
  });

  describe('snapshot validation', () => {
    it('requires a screen snapshot before element actions', async () => {
      const { host } = createTestHost();
      const lease = await host.createLease(baseCtx, { appName: 'app.notes' });

      await expect(
        host.performAction(baseCtx, lease.leaseId, {
          type: 'click_element',
          elementId: 'mock-button',
        }),
      ).rejects.toThrow('Snapshot is stale');
    });
  });

  // -----------------------------------------------------------------------
  // getStatus
  // -----------------------------------------------------------------------

  describe('getStatus', () => {
    it('returns status with provider information', async () => {
      const { host } = createTestHost();

      const status = await host.getStatus(baseCtx);
      expect(status.enabled).toBe(true);
      expect(status.providers).toHaveLength(1);
      expect(status.providers[0].providerId).toBe('mock');
      expect(status.providers[0].available).toBe(true);
      expect(status.activeLease).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // listApps
  // -----------------------------------------------------------------------

  describe('listApps', () => {
    it('returns the app list from the mock provider', async () => {
      const { host } = createTestHost();

      const apps = await host.listApps(baseCtx);
      expect(apps).toHaveLength(1);
      expect(apps[0].appId).toBe('app.notes');
      expect(apps[0].name).toBe('Mock Notes');
    });
  });

  // -----------------------------------------------------------------------
  // stop + release
  // -----------------------------------------------------------------------

  describe('stop + release', () => {
    it('releases the lease when stop is called', async () => {
      const { host, leaseRegistry } = createTestHost();

      const lease = await host.createLease(baseCtx, { appName: 'app.notes' });
      expect(leaseRegistry.getActiveLease()).not.toBeNull();

      await host.stop(baseCtx, lease.leaseId);

      const releasedLease = leaseRegistry.getLease(baseCtx, lease.leaseId);
      expect(releasedLease!.status).toBe('released');
      expect(leaseRegistry.getActiveLease()).toBeNull();
    });
  });
});
