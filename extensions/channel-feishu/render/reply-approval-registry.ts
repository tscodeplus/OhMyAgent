import type { ReplyApprovalTracker } from './approval-tracker.js';

/** Trackers older than this with no unregister are pruned opportunistically. */
const TRACKER_TTL_MS = 6 * 60 * 60 * 1000; // 6h — well beyond any approval window

export class ReplyApprovalRegistry {
  private readonly trackers = new Map<string, { tracker: ReplyApprovalTracker; at: number }>();

  register(messageId: string, tracker: ReplyApprovalTracker): void {
    this.pruneExpired();
    this.trackers.set(messageId, { tracker, at: Date.now() });
  }

  get(messageId: string | undefined): ReplyApprovalTracker | undefined {
    if (!messageId) return undefined;
    return this.trackers.get(messageId)?.tracker;
  }

  unregister(messageId: string | undefined): void {
    if (!messageId) return;
    this.trackers.delete(messageId);
  }

  /**
   * Drop entries that were never unregistered (approval timed out / errored
   * before the paired unregister ran). Without this the Map grows unbounded
   * over the process lifetime. Called opportunistically on register so no
   * background timer handle is held.
   */
  private pruneExpired(): void {
    const cutoff = Date.now() - TRACKER_TTL_MS;
    for (const [id, entry] of this.trackers) {
      if (entry.at < cutoff) this.trackers.delete(id);
    }
  }
}
