import type { CachedAnalysis } from './vision-bridge-types.js';

export class VisionBridgeCache {
  private analysisByPrompt = new Map<string, CachedAnalysis>();
  private itemIndex = 0;

  constructor(private maxEntries: number) {}

  get(key: string): string | undefined {
    const entry = this.analysisByPrompt.get(key);
    if (!entry) return undefined;
    entry.lastUsedAt = Date.now();
    return entry.note;
  }

  set(key: string, note: string): void {
    const now = Date.now();
    this.analysisByPrompt.set(key, {
      note,
      createdAt: now,
      lastUsedAt: now,
      index: this.itemIndex++,
    });
    this.trim();
  }

  clear(): void {
    this.analysisByPrompt.clear();
  }

  get size(): number {
    return this.analysisByPrompt.size;
  }

  private trim(): void {
    while (this.analysisByPrompt.size > this.maxEntries) {
      let oldest: { key: string; lastUsedAt: number } | null = null;
      for (const [k, v] of this.analysisByPrompt) {
        if (!oldest || v.lastUsedAt < oldest.lastUsedAt) {
          oldest = { key: k, lastUsedAt: v.lastUsedAt };
        }
      }
      if (oldest) {
        this.analysisByPrompt.delete(oldest.key);
      }
    }
  }
}
