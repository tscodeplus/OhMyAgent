// ---------------------------------------------------------------------------
// Shared media provider infrastructure
// ---------------------------------------------------------------------------

export interface MediaProvider {
  readonly id: string;
  isAvailable(): boolean;
}

/**
 * Generic fallback-chain executor.
 * Tries providers in array order and returns the first successful result.
 * Throws an aggregate error if all providers fail or none are available.
 */
export async function runWithFallback<T extends MediaProvider, R>(
  providers: T[],
  fn: (p: T) => Promise<R>,
): Promise<{ result: R; providerId: string }> {
  const available = providers.filter(p => p.isAvailable());
  if (available.length === 0) {
    throw new Error(
      'No provider available. Configure at least one provider with a valid API key or endpoint.',
    );
  }
  const errors: Array<{ providerId: string; error: string }> = [];
  for (const provider of available) {
    try {
      const result = await fn(provider);
      return { result, providerId: provider.id };
    } catch (err) {
      errors.push({ providerId: provider.id, error: String(err) });
    }
  }
  throw new Error(
    `All providers failed: ${errors.map(e => `${e.providerId}: ${e.error}`).join('; ')}`,
  );
}
