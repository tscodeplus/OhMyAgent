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
// Lookups are cached (a name changes rarely) and bounded (an inbox request must
// not wait on a platform that stopped answering).
// ---------------------------------------------------------------------------

import type { Logger } from 'pino';

/** Resolves a channel's own display name from its platform. Empty = unknown. */
export type BotNameResolver = () => Promise<string | null | undefined>;

/** How long a discovered name is trusted before asking again. */
const DEFAULT_TTL_MS = 10 * 60_000;
/** Retry interval after a failed lookup — shorter than the TTL: the platform was
 *  unreachable, which says nothing about whether the name changed. */
const DEFAULT_RETRY_MS = 60_000;
/** A lookup must never hold a request open longer than this. */
const DEFAULT_TIMEOUT_MS = 3_000;

interface Entry {
  /** Last name the platform reported, kept across failures so a transient
   *  outage degrades to a stale label instead of a bare channel name. */
  name: string | null;
  fetchedAt: number;
  /** True when `fetchedAt` came from a successful lookup. */
  ok: boolean;
  inFlight: Promise<string | null> | null;
}

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
  timeoutMs?: number;
}

export class BotIdentityRegistry {
  private readonly resolvers = new Map<string, BotNameResolver>();
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly retryMs: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly logger?: Logger,
    options: BotIdentityOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Teach the registry how to ask a channel for its name. Called by the channel
   * extension at load time — including channels whose startup is skipped later,
   * because "disabled in config.yaml" is exactly when the inbox still has old
   * transcripts to label.
   */
  register(channel: string, resolver: BotNameResolver): void {
    this.resolvers.set(channel, resolver);
    // Warm the cache: the first inbox render would otherwise wait on a platform
    // round-trip (up to `timeoutMs`) and show a bare channel label until it lands.
    void this.resolve(channel);
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
    if (entry) {
      const age = Date.now() - entry.fetchedAt;
      if (age < (entry.ok ? this.ttlMs : this.retryMs)) {
        return entry.name ?? undefined;
      }
    }

    const resolver = this.resolvers.get(channel);
    if (!resolver) return entry?.name ?? undefined;

    return (await this.refresh(channel, resolver)) ?? undefined;
  }

  /** Single-flight per channel: a burst of inbox requests shares one lookup. */
  private refresh(channel: string, resolver: BotNameResolver): Promise<string | null> {
    const existing = this.entries.get(channel);
    if (existing?.inFlight) return existing.inFlight;

    const started: Entry = existing ?? { name: null, fetchedAt: 0, ok: false, inFlight: null };
    const run = (async (): Promise<string | null> => {
      const entry = this.entries.get(channel) ?? started;
      try {
        const reported = await withTimeout(Promise.resolve(resolver()), this.timeoutMs);
        const name = typeof reported === 'string' ? reported.trim() : '';
        // An empty answer is "the platform has nothing to say", not "the bot is
        // nameless": keep the previous name rather than dropping the label.
        if (name) entry.name = name;
        entry.fetchedAt = Date.now();
        // An empty answer is not a successful lookup: a bot whose name has not
        // been filled in yet should be re-read soon, not cached for a full TTL.
        entry.ok = Boolean(name);
        if (name && name !== existing?.name) {
          this.logger?.info({ channel, name }, 'Bot name resolved from platform');
        }
        return entry.name;
      } catch (err) {
        entry.fetchedAt = Date.now();
        entry.ok = false;
        this.logger?.warn({ err, channel }, 'Bot name lookup failed');
        return entry.name;
      } finally {
        entry.inFlight = null;
        this.entries.set(channel, entry);
      }
    })();

    started.inFlight = run;
    this.entries.set(channel, started);
    return run;
  }
}
