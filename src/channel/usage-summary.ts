import type { FooterConfig, Usage } from '../app/types.js';

export function computeCacheHitRate(usage: Pick<Usage, 'input' | 'cacheRead' | 'cacheWrite'>): number | undefined {
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  // Show cache hit rate even when cacheRead is 0, so users see consistent
  // footer behavior across providers that do/don't support prompt caching.
  if (promptTokens <= 0) return undefined;
  return (usage.cacheRead || 0) / promptTokens;
}

export function formatUsageSummary(usage?: Usage, footerConfig?: FooterConfig): string | undefined {
  if (!usage) return undefined;

  const parts: string[] = [];

  if (footerConfig?.showUsage ?? false) {
    const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    parts.push(`↓ ${inputTokens} ↑ ${usage.output}`);
  }

  const hitRate = computeCacheHitRate(usage);
  if ((footerConfig?.showCacheHitRate ?? false) && hitRate !== undefined) {
    parts.push(`缓存命中 ${(hitRate * 100).toFixed(1)}%`);
  }

  return parts.length > 0 ? parts.join(' · ') : undefined;
}
