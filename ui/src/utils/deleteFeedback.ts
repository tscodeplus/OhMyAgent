import type { TFunction } from 'i18next';
import type { DeleteSkipReason } from '../types/archive';

/**
 * Turn the `skipped` list of a batch delete into one operator-readable line.
 *
 * A batch delete is partial by design (a row can be mid-reply, or already gone on
 * another device), and three lists — project chats, inbox, 归档 — can trigger it.
 * Sharing the wording here is what keeps "2 个会话未删除（1 个正在回复中）" identical
 * in all three instead of three slightly different phrasings of the same fact.
 *
 * Returns `null` when nothing was skipped, so callers can skip the second toast.
 */
export function describeSkippedDeletes(
  t: TFunction,
  skipped: ReadonlyArray<{ reason: DeleteSkipReason }>,
): string | null {
  if (skipped.length === 0) return null;

  const counts: Record<DeleteSkipReason, number> = { running: 0, not_found: 0, failed: 0 };
  for (const item of skipped) counts[item.reason] += 1;

  const reasons: string[] = [];
  if (counts.running > 0) reasons.push(t('selection.skipRunning', { count: counts.running }));
  if (counts.not_found > 0) reasons.push(t('selection.skipMissing', { count: counts.not_found }));
  if (counts.failed > 0) reasons.push(t('selection.skipFailed', { count: counts.failed }));

  return t('selection.deletePartial', {
    count: skipped.length,
    reasons: reasons.join(t('selection.reasonSeparator')),
  });
}
