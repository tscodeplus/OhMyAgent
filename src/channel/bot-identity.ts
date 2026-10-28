// ---------------------------------------------------------------------------
// Bot display names, discovered from the platform instead of configured.
//
// Every channel labels its inbox group with the bot that owns it ("小书 · 飞书").
// A configured name cannot be trusted for that: the bot is renamed in the
// platform's own console (Feishu app name, Telegram BotFather, QQ 机器人资料),
// and nothing pushes that change back into config.yaml — so the inbox keeps
// showing a name that no chat window matches, and the operator has no reason to
// suspect the config file. Each channel's API can answer the question with the
// credentials it already holds, so the platform stays the single source of truth.
//
// Lookups are cached for a day (a renamed bot is not urgent news), bounded (an
// inbox request must not wait on a platform that stopped answering), and retried
// a few times with a short delay after a failure — the common case there is a
// receiver/NAT that is not up yet at boot, not a bot whose name changed.
//
// The last name the platform confirmed is also persisted, because the case this
// matters most for is exactly the one an in-memory cache cannot cover: a machine
// that boots while offline. Without it, an offline start after a rename would
// silently show the bare channel name ("QQ") instead of the last known one.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';

/** Resolves a channel's own display name from its platform. Empty = unknown. */
export type BotNameResolver = () => Promise<string | null | undefined>;

/** How long a discovered name is trusted before asking again. */
const DEFAULT_TTL_MS = 24 * 60 * 60_000;
/** Delay before retrying a failed lookup. */
const DEFAULT_RETRY_MS = 60_000;
/** Retries after the first attempt before giving up until the daily refresh. */
const DEFAULT_MAX_RETRIES = 5;
/** A lookup must never hold a request open longer than this. */
const DEFAULT_TIMEOUT_MS = 3_000;
/** Floor for any scheduled attempt — see the clamp in schedule(). */
const MIN_SCHEDULE_MS = 1_000;

interface Entry {
  /** Last name the platform reported, kept across failures so a transient
   *  outage degrades to a stale label instead of a bare channel name. */
  name: string | null;
  /** When `name` was last confirmed, or when the last attempt failed. */
  fetchedAt: number;
  /** True when `fetchedAt` came from a successful lookup. */
  ok: boolean;
  /** Consecutive failures since the last success. */
  failures: number;
  inFlight: Promise<string | null> | null;
  nextAttempt?: NodeJS.Timeout;
}

/** On-disk shape: only what a restarted process cannot re-derive. */
type PersistedStore = Record<string, { name: string; fetchedAt: number }>;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`bot name lookup timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export interface BotIdentityOptions {
  ttlMs?: number;
  retryMs?: number;
  maxRetries?: number;
  timeoutMs?: number;
  /** Where last-known names survive a restart. Omitted = memory only. */
  storePath?: string;
  /** False disables the retry/refresh timers (tests drive attempts by hand). */
  autoRefresh?: boolean;
}

export class BotIdentityRegistry {
  private readonly resolvers = new Map<string, BotNameResolver>();
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly retryMs: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly storePath?: string;
  private readonly autoRefresh: boolean;
  private persisted: PersistedStore = {};

  constructor(
    private readonly logger?: Logger,
    options: BotIdentityOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.storePath = options.storePath;
    this.autoRefresh = options.autoRefresh ?? true;
    this.loadStore();
  }

  /**
   * Teach the registry how to ask a channel for its name. Called by the channel
   * extension at load time — including channels whose startup is skipped later,
   * because "disabled in config.yaml" is exactly when the inbox still has old
   * transcripts to label.
   */
  register(channel: string, resolver: BotNameResolver): void {
    this.resolvers.set(channel, resolver);
    // Ask right away: the first inbox render must not wait on a platform
    // round-trip, and a boot-time failure is what the retry schedule is for.
    void this.attempt(channel);
  }

  /** Last known name, with no I/O. For callers that cannot await. */
  cached(channel: string): string | undefined {
    return this.entries.get(channel)?.name ?? undefined;
  }

  /**
   * The channel's current name, looking it up if the cached copy is stale.
   * Never throws and never takes longer than `timeoutMs` — callers use the
   * result as a label, so "unknown" has to be a normal outcome.
   */
  async resolve(channel: string): Promise<string | undefined> {
    const entry = this.entries.get(channel);
    if (entry && this.isFresh(entry)) return entry.name ?? undefined;

    const resolver = this.resolvers.get(channel);
    if (!resolver) return entry?.name ?? undefined;

    return (await this.attempt(channel)) ?? undefined;
  }

  /** Stop all scheduled work (process shutdown, or a test that re-registers). */
  dispose(): void {
    for (const entry of this.entries.values()) {
      if (entry.nextAttempt) clearTimeout(entry.nextAttempt);
      entry.nextAttempt = undefined;
    }
  }

  /**
   * Freshness depends on how the last attempt went: a confirmed name is good for
   * a day, a single failure is retried after a minute, and once the retries are
   * spent the channel waits for the daily refresh instead of hammering the API.
   */
  private isFresh(entry: Entry): boolean {
    const age = Date.now() - entry.fetchedAt;
    if (entry.ok) return age < this.ttlMs;
    return age < (entry.failures > this.maxRetries ? this.ttlMs : this.retryMs);
  }

  /** Single-flight per channel: a burst of readers shares one lookup. */
  private attempt(channel: string): Promise<string | null> {
    const existing = this.entries.get(channel);
    if (existing?.inFlight) return existing.inFlight;

    const resolver = this.resolvers.get(channel);
    if (!resolver) return Promise.resolve(existing?.name ?? null);

    const entry: Entry = existing ?? {
      name: null,
      fetchedAt: 0,
      ok: false,
      failures: 0,
      inFlight: null,
    };
    if (entry.nextAttempt) {
      clearTimeout(entry.nextAttempt);
      entry.nextAttempt = undefined;
    }

    const run = (async (): Promise<string | null> => {
      try {
        const reported = await withTimeout(Promise.resolve(resolver()), this.timeoutMs);
        const name = typeof reported === 'string' ? reported.trim() : '';
        if (name) {
          if (name !== entry.name) {
            this.logger?.info({ channel, name }, 'Bot name resolved from platform');
          }
          entry.name = name;
          entry.ok = true;
          entry.failures = 0;
          entry.fetchedAt = Date.now();
          this.saveStore(channel, name, entry.fetchedAt);
        } else {
          // The platform answered but has no name for this bot (empty username is
          // a real QQ quirk). Not a success: retry later in case it gets filled
          // in, but keep whatever label we already had.
          entry.ok = false;
          entry.failures += 1;
          entry.fetchedAt = Date.now();
        }
        return entry.name;
      } catch (err) {
        entry.ok = false;
        entry.failures += 1;
        entry.fetchedAt = Date.now();
        this.logger?.warn(
          { err, channel, failures: entry.failures },
          entry.failures > this.maxRetries
            ? 'Bot name lookup failed, giving up until the next daily refresh'
            : 'Bot name lookup failed, will retry',
        );
        return entry.name;
      } finally {
        entry.inFlight = null;
        this.entries.set(channel, entry);
        this.schedule(channel, entry);
      }
    })();

    entry.inFlight = run;
    this.entries.set(channel, entry);
    return run;
  }

  private schedule(channel: string, entry: Entry): void {
    if (!this.autoRefresh) return;
    if (entry.nextAttempt) clearTimeout(entry.nextAttempt);

    const target = entry.ok
      ? this.ttlMs
      : entry.failures > this.maxRetries
        ? this.ttlMs
        : this.retryMs;
    // Clamp: a zero delay (tests, or a misconfiguration) would otherwise turn the
    // retry into a busy loop against the platform.
    const delay = Math.max(target, MIN_SCHEDULE_MS);

    const timer = setTimeout(() => {
      entry.nextAttempt = undefined;
      // A timer must not be the only thing keeping the process alive.
      void this.attempt(channel).catch(() => {});
    }, delay);
    timer.unref?.();
    entry.nextAttempt = timer;
  }

  // ─── Persistence ─────────────────────────────────────────────────────────

  private loadStore(): void {
    if (!this.storePath) return;
    try {
      const raw = fs.readFileSync(this.storePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      for (const [channel, value] of Object.entries(parsed as Record<string, unknown>)) {
        const entry = value as { name?: unknown; fetchedAt?: unknown };
        if (typeof entry?.name !== 'string' || !entry.name) continue;
        const fetchedAt = typeof entry.fetchedAt === 'number' ? entry.fetchedAt : 0;
        this.persisted[channel] = { name: entry.name, fetchedAt };
        // Seed the cache as "stale but known", so an offline start still has a
        // label and the first resolve() tries the platform again.
        this.entries.set(channel, {
          name: entry.name,
          fetchedAt: 0,
          ok: false,
          failures: 0,
          inFlight: null,
        });
      }
    } catch (err) {
      // ENOENT on first run is the normal path; anything else is worth a line.
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.logger?.warn({ err }, 'Could not read cached bot names, starting empty');
      }
    }
  }

  private saveStore(channel: string, name: string, fetchedAt: number): void {
    if (!this.storePath) return;
    if (this.persisted[channel]?.name === name) return;
    this.persisted[channel] = { name, fetchedAt };
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      fs.writeFileSync(this.storePath, JSON.stringify(this.persisted, null, 2), 'utf8');
    } catch (err) {
      this.logger?.warn({ err, channel }, 'Could not persist bot name');
    }
  }
}
