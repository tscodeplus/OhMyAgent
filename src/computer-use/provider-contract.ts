// src/computer-use/provider-contract.ts

import type { Ctx, ProviderStatus, AppInfo, Lease, Target, AppState, Action, ActionResult, ComputerUseCapabilities } from './types.js';

export interface ComputerUseProvider {
  providerId: string;
  capabilities: ComputerUseCapabilities;

  getStatus(ctx: Ctx): Promise<ProviderStatus>;
  listApps(ctx: Ctx): Promise<AppInfo[]>;

  // Lease lifecycle
  createLease(ctx: Ctx, target: Target): Promise<Lease>;
  releaseLease(ctx: Ctx, lease: Lease): Promise<void>;

  // Operations
  getAppState(ctx: Ctx, lease: Lease): Promise<AppState>;
  performAction(ctx: Ctx, lease: Lease, action: Action): Promise<ActionResult>;
  stop(ctx: Ctx, lease: Lease): Promise<void>;

  /** Optional: close/terminate an app by name. */
  closeApp?(ctx: Ctx, target: string): Promise<void>;
}

export const COMPUTER_PROVIDER_CAPABILITY_DEFAULTS: ComputerUseCapabilities = {
  platform: 'sandbox',
  observationModes: ['vision-native'],
  screenshot: false,
  accessibilityTree: false,
  elementActions: false,
  elementDoubleClick: false,
  backgroundControl: 'none',
  pointClick: 'unsupported',
  drag: 'unsupported',
  textInput: 'unsupported',
  keyboardInput: 'unsupported',
  requiresForegroundForInput: true,
  nativeCursor: false,
  isolated: false,
  supportsFocusApp: false,
  supportsCloseApp: false,
};

export function normalizeComputerProviderCapabilities(
  partial?: Partial<ComputerUseCapabilities>,
): ComputerUseCapabilities {
  return {
    ...COMPUTER_PROVIDER_CAPABILITY_DEFAULTS,
    ...partial,
    observationModes: partial?.observationModes
      ? [...partial.observationModes]
      : [...COMPUTER_PROVIDER_CAPABILITY_DEFAULTS.observationModes],
  };
}
