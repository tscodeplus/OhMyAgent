// src/computer-use/providers/mock-provider.ts

import type { ComputerUseProvider } from '../provider-contract.js';
import type { Ctx, Lease, Target, AppState, AppInfo, ProviderStatus, Action, ActionResult } from '../types.js';
import { normalizeComputerProviderCapabilities } from '../provider-contract.js';

const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

export interface MockComputerProvider extends ComputerUseProvider {
  readonly actions: ReadonlyArray<{ leaseId: string; action: Partial<Action> }>;
}

export function createMockComputerProvider(options?: { providerId?: string }): MockComputerProvider {
  const providerId = options?.providerId ?? 'mock';
  const _actions: { leaseId: string; action: Partial<Action> }[] = [];

  return {
    providerId,

    capabilities: normalizeComputerProviderCapabilities({
      platform: 'sandbox',
      observationModes: ['vision-native'],
      screenshot: true,
      accessibilityTree: true,
      elementActions: true,
      elementDoubleClick: false,
      backgroundControl: 'full',
      pointClick: 'unsupported',
      drag: 'unsupported',
      textInput: 'semantic',
      keyboardInput: 'pidScoped',
      requiresForegroundForInput: false,
      nativeCursor: false,
      isolated: true,
    }),

    async getStatus(_ctx: Ctx): Promise<ProviderStatus> {
      return { providerId, available: true, permissions: [] };
    },

    async listApps(_ctx: Ctx): Promise<AppInfo[]> {
      return [
        {
          appId: 'app.notes',
          name: 'Mock Notes',
          windows: [{ windowId: 'win-1', title: 'Notes' }],
        },
      ];
    },

    async createLease(_ctx: Ctx, target: Target): Promise<Lease> {
      return {
        leaseId: 'mock-lease-1',
        sessionPath: _ctx.sessionPath ?? '',
        agentId: _ctx.agentId ?? '',
        providerId,
        appId: target.appId ?? 'app.notes',
        windowId: target.windowId ?? 'win-1',
        createdAt: new Date().toISOString(),
        status: 'active',
        allowedActions: [
          'click_element',
          'type_text',
          'press_key',
          'scroll',
          'perform_secondary_action',
          'stop',
        ],
        providerState: { mock: true },
      };
    },

    async releaseLease(_ctx: Ctx, _lease: Lease): Promise<void> {
      // no-op
    },

    async getAppState(_ctx: Ctx, lease: Lease): Promise<AppState> {
      return {
        mode: 'vision-native',
        screenshot: {
          type: 'image',
          mimeType: 'image/png',
          data: ONE_PIXEL_PNG_BASE64,
        },
        display: { width: 800, height: 600, scaleFactor: 1 },
        focusedElementId: 'mock-input',
        windowTitle: 'Mock Notes',
        elements: [
          {
            elementId: 'mock-button',
            role: 'button',
            label: 'Continue',
            bounds: { x: 100, y: 120, width: 160, height: 44 },
            enabled: true,
          },
          {
            elementId: 'mock-input',
            role: 'textbox',
            label: 'Name',
            value: '',
            bounds: { x: 100, y: 180, width: 260, height: 36 },
            enabled: true,
          },
        ],
      };
    },

    async performAction(_ctx: Ctx, lease: Lease, action: Action): Promise<ActionResult> {
      _actions.push({ leaseId: lease.leaseId, action });
      return { ok: true, action: action.type };
    },

    async stop(_ctx: Ctx, _lease: Lease): Promise<void> {
      _actions.push({ leaseId: _lease.leaseId, action: { type: 'stop' } });
    },

    get actions() {
      return _actions as ReadonlyArray<{ leaseId: string; action: Partial<Action> }>;
    },
  };
}
