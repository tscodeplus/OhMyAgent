import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

export type MemoryObservationEvent =
  | 'memory.embedding.failed'
  | 'memory.embedding.vec_insert_failed'
  | 'memory.vector.failed'
  | 'memory.vector.full_scan_skipped'
  | 'memory.fts.failed'
  | 'memory.merge.failed'
  | 'memory.entity.failed'
  | 'memory.summary.parse_failed'
  | 'memory.write.degraded';

export interface MemoryObservation {
  event: MemoryObservationEvent;
  at: string;
  details?: Record<string, unknown>;
}

export interface MemoryObservationSink {
  record(event: MemoryObservationEvent, details?: Record<string, unknown>): void;
  snapshot(): MemoryObservationReport;
  clear(): void;
}

export interface MemoryObservationReport {
  total: number;
  counts: Record<string, number>;
  recent: MemoryObservation[];
}

const MAX_RECENT = 100;

class InMemoryObservationSink implements MemoryObservationSink {
  private counts = new Map<string, number>();
  private recent: MemoryObservation[] = [];
  private db?: Database.Database;

  attachDatabase(db: Database.Database): void {
    this.db = db;
  }

  record(event: MemoryObservationEvent, details?: Record<string, unknown>): void {
    const sanitized = sanitizeDetails(details);
    this.counts.set(event, (this.counts.get(event) ?? 0) + 1);
    this.recent.push({
      event,
      at: new Date().toISOString(),
      details: sanitized,
    });
    if (this.recent.length > MAX_RECENT) {
      this.recent = this.recent.slice(-MAX_RECENT);
    }
    if (this.db?.open) {
      try {
        this.db.prepare(`
          INSERT INTO memory_observation_events (event, details)
          VALUES (?, ?)
        `).run(event, sanitized ? JSON.stringify(sanitized) : null);
      } catch {
        // Observability must never break the memory path.
      }
    }
  }

  snapshot(): MemoryObservationReport {
    const persisted = this.snapshotPersisted();
    if (persisted) return persisted;
    return {
      total: Array.from(this.counts.values()).reduce((sum, count) => sum + count, 0),
      counts: Object.fromEntries(this.counts),
      recent: [...this.recent],
    };
  }

  clear(): void {
    this.counts.clear();
    this.recent = [];
    if (this.db?.open) {
      try {
        this.db.prepare('DELETE FROM memory_observation_events').run();
      } catch {
        // ignore test cleanup failures
      }
    }
  }

  private snapshotPersisted(): MemoryObservationReport | null {
    if (!this.db?.open) return null;
    try {
      const countRows = this.db.prepare(`
        SELECT event, COUNT(*) as count
        FROM memory_observation_events
        GROUP BY event
      `).all() as Array<{ event: string; count: number }>;
      const recentRows = this.db.prepare(`
        SELECT event, details, created_at
        FROM memory_observation_events
        ORDER BY id DESC
        LIMIT ?
      `).all(MAX_RECENT) as Array<{ event: MemoryObservationEvent; details: string | null; created_at: string }>;
      const counts = Object.fromEntries(countRows.map(row => [row.event, row.count]));
      return {
        total: countRows.reduce((sum, row) => sum + row.count, 0),
        counts,
        recent: recentRows.reverse().map(row => ({
          event: row.event,
          at: row.created_at,
          details: row.details ? safeParseDetails(row.details) : undefined,
        })),
      };
    } catch {
      return null;
    }
  }
}

export const memoryObservability: MemoryObservationSink = new InMemoryObservationSink();

export function attachMemoryObservabilityDb(db: Database.Database): void {
  (memoryObservability as InMemoryObservationSink).attachDatabase(db);
}

export function hashForObservation(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function errorForObservation(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160);
}

function sanitizeDetails(details?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === 'string') {
      sanitized[key] = value.length > 200 ? `${value.slice(0, 200)}...` : value;
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function safeParseDetails(json: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}
