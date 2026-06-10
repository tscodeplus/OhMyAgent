// src/computer-use/provider-registry.ts

import type { ComputerUseProvider } from './provider-contract.js';
import type { ComputerUseSettings } from './settings.js';
import { computerUseError } from './errors.js';

export const DEFAULT_PROVIDER_BY_PLATFORM: Record<string, string> = {
  linux: 'nutjs',
  win32: 'nutjs',
  darwin: 'nutjs',
};

export class ComputerProviderRegistry {
  private _providers = new Map<string, ComputerUseProvider>();

  register(provider: ComputerUseProvider): void {
    this._providers.set(provider.providerId, provider);
  }

  get(id: string): ComputerUseProvider | undefined {
    return this._providers.get(id);
  }

  require(id: string): ComputerUseProvider {
    const provider = this._providers.get(id);
    if (!provider) {
      throw computerUseError(
        'PROVIDER_UNAVAILABLE',
        `Computer provider not found: ${id}`,
        { providerId: id },
      );
    }
    return provider;
  }

  list(): ComputerUseProvider[] {
    return Array.from(this._providers.values());
  }

  has(id: string): boolean {
    return this._providers.has(id);
  }
}

export interface ResolveProviderOptions {
  explicitProviderId?: string | null;
  settings: ComputerUseSettings;
  platform?: string;
  defaultProviderId: string;
  hasProvider: (id: string) => boolean;
}

export function resolveComputerProviderId(options: ResolveProviderOptions): string {
  const { explicitProviderId, settings, platform = process.platform, defaultProviderId, hasProvider } = options;

  // 1. Explicit provider ID takes priority
  if (explicitProviderId) return explicitProviderId;

  // 2. Per-platform override from settings
  const platformOverride = settings.perPlatformProvider[platform];
  if (platformOverride && hasProvider(platformOverride)) {
    return platformOverride;
  }

  // 3. Default provider for this platform
  const platformDefault = DEFAULT_PROVIDER_BY_PLATFORM[platform];
  if (platformDefault && hasProvider(platformDefault)) {
    return platformDefault;
  }

  // 4. Fallback
  return defaultProviderId;
}
