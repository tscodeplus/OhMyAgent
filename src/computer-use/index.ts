// src/computer-use/index.ts
//
// Barrel exports for the Computer Use module.

// Classes
export { ComputerUseHost } from './computer-host.js';
export { ComputerLeaseRegistry } from './lease-registry.js';
export { ComputerProviderRegistry, resolveComputerProviderId, DEFAULT_PROVIDER_BY_PLATFORM } from './provider-registry.js';

// Providers
export { SSHComputerUseProvider } from './providers/ssh-provider.js';
export { LocalWindowsProvider } from './providers/local-windows.js';
export { NutJSProvider } from './providers/local-nutjs.js';
export { createMockComputerProvider } from './providers/mock-provider.js';
export type { MockComputerProvider } from './providers/mock-provider.js';

// Errors
export { computerUseError, COMPUTER_USE_ERRORS } from './errors.js';
export type { ComputerUseError, ComputerUseErrorCode } from './errors.js';

// Settings
export { normalizeComputerUseSettings } from './settings.js';
export type { ComputerUseSettings, ComputerUseSSHSettings, ComputerUseNodeSettings, ComputerUseProviderMode } from './settings.js';

// Provider contract
export type { ComputerUseProvider } from './provider-contract.js';
export { normalizeComputerProviderCapabilities, COMPUTER_PROVIDER_CAPABILITY_DEFAULTS } from './provider-contract.js';

// Model policy
export { isComputerUseModelSupported } from './model-policy.js';

// Types
export type { Ctx, ProviderStatus, AppInfo, WindowInfo, ComputerUseCapabilities, AppState, UIElement, ActionType, Action, ActionResult, Lease, Target } from './types.js';
