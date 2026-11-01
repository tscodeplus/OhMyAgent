/**
 * The two lists a provider/model picker needs to be honest.
 *
 * `/api/providers` returns the *whole* pi-mono catalog — every provider the build
 * knows about, whether or not this install can call it. Offering those in a model
 * picker is how you end up with a saved `notes.capture.modelRef` pointing at a
 * provider that has no key: the field looks configured, and the first capture fails
 * with "No API key resolved" instead of the picker saying so.
 *
 * So:
 *   - `configuredProviders` — ids that actually hold a credential (`provider_keys`,
 *     `custom_providers`, or the primary `piAi` provider), from
 *     `/api/providers/configured`. `ModelPicker` filters its dropdown down to these.
 *   - `extraProviders` — custom providers, which `/api/providers` deliberately does
 *     not list (it returns builtins only), so they would otherwise vanish from the
 *     dropdown entirely.
 *
 * Both fetches fail soft. `configuredProviders` stays `undefined` on error, which
 * makes `ModelPicker` show the full list rather than an empty dropdown — a degraded
 * lineup beats a picker with nothing in it.
 */

import { useEffect, useMemo, useState } from 'react';
import { apiRequest } from '../../utils/api';
import type { ProviderOption } from './ModelPicker';

export interface UseConfiguredProvidersResult {
  /** Ids with a configured credential; `undefined` = unknown, show everything. */
  configuredProviders: string[] | undefined;
  /** Custom providers to append to the builtin dropdown. */
  extraProviders: ProviderOption[];
}

export function useConfiguredProviders(
  customProviders?: Array<{ provider?: string }> | null,
): UseConfiguredProvidersResult {
  const [configuredProviders, setConfiguredProviders] = useState<string[] | undefined>(undefined);
  // Every builtin id, not just the ones with a key: this set exists only to tell a
  // custom provider from a builtin one, so that e.g. `nvidia` (builtin *and* listed
  // under custom_providers) is not appended a second time as `custom/nvidia`.
  const [builtinIds, setBuiltinIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    apiRequest<{ providers: Array<{ id: string }> }>('/api/providers/configured')
      .then((data) => setConfiguredProviders(data.providers.map((p) => p.id)))
      .catch(() => setConfiguredProviders(undefined));
  }, []);

  useEffect(() => {
    apiRequest<{ providers: Array<{ id: string }> }>('/api/providers')
      .then((data) => setBuiltinIds(new Set(data.providers.map((p) => p.id))))
      .catch(() => setBuiltinIds(new Set()));
  }, []);

  const extraProviders = useMemo(() => {
    const seen = new Set<string>();
    const options: ProviderOption[] = [];
    for (const cp of customProviders ?? []) {
      const id = cp?.provider;
      if (!id || builtinIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      options.push({ value: id, label: `custom/${id}` });
    }
    return options;
  }, [customProviders, builtinIds]);

  return { configuredProviders, extraProviders };
}
