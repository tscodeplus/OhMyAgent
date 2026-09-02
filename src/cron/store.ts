import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CronJob, CronStoreData } from './types.js';

function defaultData(): CronStoreData {
  return { version: 1, jobs: [] };
}

export class CronStore {
  private data: CronStoreData;
  private filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    const resolved = dataDir.replace(/^~/, process.env.HOME ?? '~');
    if (!existsSync(resolved)) {
      mkdirSync(resolved, { recursive: true });
    }
    this.filePath = path.join(resolved, 'cron-jobs.json');
    this.data = this.load();
  }

  // ── public readers ──

  list(): CronJob[] {
    return [...this.data.jobs];
  }

  get(id: string): CronJob | undefined {
    return this.data.jobs.find(j => j.id === id);
  }

  getDueJobs(nowMs: number): CronJob[] {
    return this.data.jobs.filter(
      j => j.enabled && j.state === 'idle' && j.nextRunAt !== null && j.nextRunAt <= nowMs,
    );
  }

  // ── mutators (serialized via writeQueue) ──

  add(job: CronJob): void {
    this.data.jobs.push(job);
    this.schedulePersist();
  }

  update(id: string, patch: Partial<CronJob>): boolean {
    const job = this.data.jobs.find(j => j.id === id);
    if (!job) return false;
    Object.assign(job, patch, { updatedAt: Date.now() });
    this.schedulePersist();
    return true;
  }

  remove(id: string): boolean {
    const idx = this.data.jobs.findIndex(j => j.id === id);
    if (idx === -1) return false;
    this.data.jobs.splice(idx, 1);
    this.schedulePersist();
    return true;
  }

  // ── persistence ──

  private schedulePersist(): void {
    // doPersist() is synchronous and CAN throw (ENOSPC, EACCES, a Windows AV
    // locking the rename). Without a catch the rejection (a) escapes as an
    // unhandled rejection — src/index.ts turns that into process.exit(1) — and
    // (b) poisons the chain forever, because every later schedulePersist()
    // derives from the already-rejected promise, so no cron write is ever
    // persisted again. Swallow-and-log keeps the chain fulfilled.
    this.writeQueue = this.writeQueue.then(() => this.doPersist()).catch((err: unknown) => {
      // No logger is injected into CronStore, and creating a pino transport at
      // module scope would leak a worker thread into every importer (tests).
      // console.error is the same emergency channel bootstrap uses on shutdown.
      console.error('[CronStore] persist failed — cron.json may be stale:', err);
    });
  }

  private doPersist(): void {
    const tmp = this.filePath + '.tmp';
    const json = JSON.stringify(this.data, null, 2);
    writeFileSync(tmp, json, 'utf-8');
    renameSync(tmp, this.filePath);
  }

  private load(): CronStoreData {
    try {
      if (!existsSync(this.filePath)) return defaultData();
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as CronStoreData;
      if (parsed?.version === 1 && Array.isArray(parsed.jobs)) {
        // Backfill missing channel field for jobs created before multi-channel support
        for (const job of parsed.jobs) {
          if (!(job as any).channel) {
            (job as any).channel = 'feishu';
          }
        }
        return parsed;
      }
      return defaultData();
    } catch {
      // Corrupted file — rename and start fresh
      try {
        const ts = Date.now();
        renameSync(this.filePath, `${this.filePath}.corrupted-${ts}`);
      } catch { /* best-effort */ }
      return defaultData();
    }
  }

  /**
   * Block until all pending writes are flushed. Useful for testing.
   */
  async flush(): Promise<void> {
    await this.writeQueue;
  }
}
