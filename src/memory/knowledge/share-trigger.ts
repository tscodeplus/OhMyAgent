/**
 * Share-curation trigger — the automatic half of the third curation entry point
 * (plan §6 K2-5).
 *
 * `/knowledge share <ref>` curates a link because somebody typed a command. This
 * module does the same when nobody types anything: a user message that carries a
 * URL is a share, so it becomes at most one knowledge page through the *same*
 * `KnowledgeCurator.curateMessage` call — one page identity, one write path, one
 * admission check. There is deliberately no new config key (`curate.trigger_on_share`
 * was deleted from the schema for exactly this reason): `knowledge.enabled: false`
 * and `curate.mode: off` already are the off switches, and the trigger adds no
 * third one.
 *
 * Three constraints shape the code, and each one is a way this feature could hurt
 * a phone:
 *
 *   - **Never on the reply path.** The trigger is called from
 *     `MessageRepository.create` while a turn is still streaming. It only
 *     enqueues: the queue is serialized, the first await of every job is a timer
 *     tick, and every failure is logged rather than thrown — a knowledge page is
 *     never a reason a reply fails. Curation also writes pages, and holding the
 *     SQLite write lock while a reply is being delivered is the failure §9.4 rule
 *     2 forbids.
 *   - **One page per message, and free on retry.** `curateMessage` is already
 *     idempotent in its *effect* — the slug is derived from the subject, so a
 *     re-delivery UPDATEs the page instead of creating a second one — but it is
 *     not free: it costs an aux-LLM call. A bounded seen-set keyed by message id
 *     makes a retry or a re-delivered message cost nothing.
 *   - **A burst is not a batch job.** A pasted list of ten links must not write
 *     ten pages, so the trigger spends `curate.max_pages_per_run` over a rolling
 *     window and then stops; the curator's own gates (`enabled`, `mode`, the aux
 *     model) are the rest of the cost control, and they are read from the
 *     curator rather than duplicated here.
 *
 * The page lands in the conversation the link was shared in: the message's
 * session is resolved to a scope (`scopeOfSession`, see `scope.ts`) and handed to
 * `curateMessage`, so a link shared in one group chat does not become an answer
 * in every other chat on the same database.
 *
 * What this module deliberately does not do: fetch a shared URL, expand an
 * attachment, or read a page title. The message is evidence, and the curator
 * already knows how to turn one message into one page. A link whose message names
 * no nameable subject produces no page — the same answer `/knowledge share` gives.
 */

/*
 * Where the trigger hangs, and why — because the obvious seams are all wrong.
 *
 * **Not the four channel extensions.** `extensions/channel-{feishu,telegram,wechat,qq}`
 * each parse their own message and then call `AgentService.execute()`; a hook
 * added to one of them would have to be added to all four, and a fifth channel
 * would silently not have it. They share no message-handling helper below
 * `AgentService` — that is the only thing the four have in common.
 *
 * **Not `persistMessages`.** `src/agent/message-persister.ts` and the eager-persist
 * branch of `agent-service.ts` are the closest correct *layer* — they are where a
 * turn's messages are written — but they sit on the turn path: `persistMessages`
 * runs from the reply's pre-complete callback, before the SSE `done` event, so
 * anything started there competes with the reply the user is waiting for.
 *
 * **Not `MemoryPipeline`** (`src/memory/memory-pipeline.ts`). It is the place that
 * looks right and is not: despite the name it is an on-demand L0→L3 *batch*
 * runner (`runFull()`/`getStatus()`, driven by the WebUI memory routes), it never
 * sees an individual message, and it has no caller that could hand it one. The
 * plan (§6 K2-5) points here; this comment is the correction, so the next reader
 * does not repeat the search.
 *
 * **The message repository is the seam.** Every channel, the WebUI and cron reach
 * the `messages` table through `MessageRepository.create`, i.e. one call, below
 * the channel layer and outside `src/agent`. A listener registered there covers
 * all of them at once, and — because it only enqueues — leaves the reply
 * untouched. It is installed by `createMemoryServices` and only when the knowledge
 * layer is actually usable (see the note there), so a disabled install pays
 * nothing at all.
 */

import type { Logger } from 'pino';
import type { KnowledgeCurator } from './curate.js';

// ── Constants ───────────────────────────────────────────────────────────

/** How long a message id counts as handled — a retry, not a new share. */
const SEEN_TTL_MS = 10 * 60 * 1000;
/** Upper bound on the seen-set; oldest entry is dropped first. */
const MAX_SEEN = 256;
/** Shares queued beyond this are dropped: one phone is not a curation farm. */
const MAX_QUEUE = 4;
/** The window over which `curate.max_pages_per_run` is spent. */
const BURST_WINDOW_MS = 60 * 1000;

/**
 * A URL in message text.
 *
 * The scheme is required: `example.com/x` in prose is a mention, not a share, and
 * a trigger that fired on it would spend a model call on ordinary sentences. The
 * excluded characters are the ones that end a link inside a chat message —
 * whitespace, quotes, `>` from markdown autolinks, and CJK brackets — so the match
 * stops at the URL instead of swallowing the rest of the line.
 */
const URL_PATTERN = /https?:\/\/[^\s<>"'`（）【】「」]+/i;

/** Trailing punctuation belongs to the sentence, not to the URL. */
const TRAILING_PUNCTUATION = /[.,;:!?、。，；：！？)\]}》」]+$/;

// ── URL detection ───────────────────────────────────────────────────────

/**
 * The first URL the message text carries, or `undefined`.
 *
 * Exported because it is the whole cost decision: nothing else happens for a
 * message that fails this check, which is what keeps the trigger from adding a
 * model call per turn.
 */
export function findSharedUrl(content: string): string | undefined {
  const match = URL_PATTERN.exec(content);
  if (!match) return undefined;
  const url = match[0].replace(TRAILING_PUNCTUATION, '');
  // `https://` with no host is not a link.
  return /^https?:\/\/./i.test(url) ? url : undefined;
}

// ── Deps ────────────────────────────────────────────────────────────────

/** The slice of a `messages` row the trigger reads. */
export interface SharedMessage {
  id: string;
  /** The session the row was stored in — how the trigger finds the chat's scope. */
  session_id: string;
  role: string;
  content: string;
}

export interface ShareCurationTriggerDeps {
  logger: Logger;
  /**
   * The live curator, or `undefined` when the knowledge layer is off.
   *
   * A getter rather than an instance because of construction order: the curator
   * is built in `createSchedulers`, after the memory services that register this
   * trigger, and read at fire time through `currentKnowledgeCurator()` — the same
   * process-wide resolver `/knowledge share` uses, so both entry points reach one
   * object. Reading it lazily also picks up a rebuilt curator without
   * re-registering anything. A throwing resolver means "no curator", not a failed
   * turn.
   */
  getCurator: () => KnowledgeCurator | undefined;
  /**
   * The scope the page belongs to, from the session the message was stored in.
   *
   * A message carries only `session_id`; the channel and the transport chat
   * handle live on the session row, and `scopeFromContext` turns them into
   * `channel:<chatId>`. This is a callback rather than a database handle so the
   * trigger stays free of repository imports — `createMemoryServices` owns the
   * lookup (see `scope.ts` for the model). Called on the caller's stack, once
   * per candidate message, and a throw is caught like every other failure here.
   */
  scopeOfSession: (sessionId: string) => string;
  /**
   * Test seam: schedules one deferred tick. Production omits it and yields with an
   * unref'd `setTimeout` — a microtask would still run inside the turn's own task,
   * which is the reply path this must stay off.
   */
  defer?: (task: () => void) => void;
}

/** Default deferral: next macrotask, and never keep the process alive for it. */
function defaultDefer(task: () => void): void {
  setTimeout(task, 0).unref();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Trigger ─────────────────────────────────────────────────────────────

export class ShareCurationTrigger {
  private readonly logger: Logger;
  private readonly defer: (task: () => void) => void;
  /** Message ids already handled → when they were handled (insertion-ordered). */
  private readonly seen = new Map<string, number>();
  /** Message ids waiting for a curation turn, oldest first. */
  private readonly queue: Array<{ messageId: string; scope: string }> = [];
  /** The serialized queue: each `observe` appends one drain to the chain. */
  private tail: Promise<void> = Promise.resolve();
  private burstStartedAt = 0;
  private burstWritten = 0;

  constructor(private readonly deps: ShareCurationTriggerDeps) {
    this.logger = deps.logger;
    this.defer = deps.defer ?? defaultDefer;
  }

  /**
   * A message row was created. Returns immediately and never throws.
   *
   * Everything that decides *whether* to spend a model call happens here, on the
   * caller's stack, because it is free: role, URL, seen-set, queue depth. The
   * curation itself never runs here.
   */
  observeUserMessage(message: SharedMessage): void {
    try {
      // Only what the user said. An assistant message that quotes a link is not a
      // share, and curating it would turn a reply into a page.
      if (message.role !== 'user') return;

      const url = findSharedUrl(message.content);
      if (!url) return;

      if (this.hasSeen(message.id)) {
        this.logger.debug(
          { messageId: message.id },
          'share curation: message already handled, not curating again',
        );
        return;
      }
      if (this.queue.length >= MAX_QUEUE) {
        this.logger.debug(
          { messageId: message.id, queued: this.queue.length },
          'share curation: queue full, dropping message',
        );
        return;
      }

      // The conversation the page belongs to, resolved while the message's
      // session identity is still on this stack. Done after the cheap refusals
      // so a dropped message costs no query.
      const scope = this.deps.scopeOfSession(message.session_id);

      // Marked as seen before the run, not after: a curation that fails must not
      // be retried forever by a client that re-delivers the message.
      this.markSeen(message.id);
      this.queue.push({ messageId: message.id, scope });
      this.tail = this.tail.then(() => this.drain());
      this.logger.debug({ messageId: message.id, url, scope }, 'share curation: queued');
    } catch (err) {
      // Called from `MessageRepository.create`: the row is already stored, and no
      // bookkeeping failure here may surface as a failed turn.
      this.logger.debug(
        { messageId: message.id, err: errorMessage(err) },
        'share curation: trigger failed (ignored)',
      );
    }
  }

  /**
   * Resolves when everything queued so far has been handled — the shutdown and
   * test handle for work the caller deliberately did not await.
   */
  async idle(): Promise<void> {
    // `observeUserMessage` may append to the chain while a drain is running, so
    // "done" is a fixed point: the same tail, and an empty queue.
    for (;;) {
      const tail = this.tail;
      await tail;
      if (this.tail === tail && this.queue.length === 0) return;
    }
  }

  /** One curation turn at a time; the queue may grow while this runs. */
  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      try {
        // The yield that keeps the first curation off the caller's task.
        await this.nextTick();
        await this.curate(job.messageId, job.scope);
      } catch (err) {
        // Nothing above may take the queue down with it: this chain is what every
        // later share waits on, so a failed job is logged and the next one runs.
        this.logger.warn(
          { messageId: job.messageId, err: errorMessage(err) },
          'share curation: queued job failed (ignored)',
        );
      }
    }
  }

  private nextTick(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.defer(resolve);
    });
  }

  /**
   * Curate one message. Every outcome is a log line, never a rejection.
   *
   * The trigger is `share`, not `manual`: both count as the explicit request of
   * admission rule 3 (so an automatic share and `/knowledge share` produce the
   * identical page from the identical message), and they differ only in the log
   * line — an automatic share and a typed command are otherwise indistinguishable
   * in `knowledge_log`, so the trigger label is the one signal that says whether
   * the feature is being used or the command is being exercised.
   */
  private async curate(messageId: string, scope: string): Promise<void> {
    const curator = this.curator();
    if (!curator) {
      this.logger.debug({ messageId }, 'share curation: no curator wired (knowledge layer off)');
      return;
    }
    // The config gate, read from the curator so there is one source of truth:
    // `knowledge.enabled: false` and `curate.mode: off` both mean "freeze
    // curation, keep pages readable", which is exactly what a share gets too.
    const limits = curator.limits;
    if (!limits.enabled || limits.mode === 'off' || limits.maxPagesPerRun <= 0) {
      this.logger.debug(
        { messageId, enabled: limits.enabled, mode: limits.mode },
        'share curation: curation is off, not curating',
      );
      return;
    }
    if (!this.burstAllows(limits.maxPagesPerRun)) {
      this.logger.debug(
        { messageId, written: this.burstWritten },
        'share curation: burst budget spent, not curating',
      );
      return;
    }

    try {
      const report = await curator.curateMessage(messageId, { trigger: 'share', scope });
      if (report.skipped) {
        this.logger.debug({ messageId, skip: report.skipped }, 'share curation: curation skipped');
        return;
      }
      this.burstWritten += report.created + report.updated;
      this.logger.info(
        {
          messageId,
          created: report.created,
          updated: report.updated,
          rejected: report.rejected,
          failed: report.failed,
        },
        'share curation: message curated',
      );
    } catch (err) {
      // A failed aux-LLM call or a failed write. The user's reply already went
      // out (or is still going out) and must not learn about this.
      this.logger.warn(
        { messageId, err: errorMessage(err) },
        'share curation: curation failed (ignored)',
      );
    }
  }

  private curator(): KnowledgeCurator | undefined {
    try {
      return this.deps.getCurator();
    } catch {
      return undefined;
    }
  }

  /**
   * Whether the current burst may still write a page.
   *
   * The cap is the curator's `max_pages_per_run` — one burst is at most one run's
   * worth of pages, so a pasted list of links cannot out-write the nightly pass.
   * Reset lazily on read, which keeps the trigger free of timers.
   */
  private burstAllows(maxPagesPerRun: number): boolean {
    const now = Date.now();
    if (now - this.burstStartedAt >= BURST_WINDOW_MS) {
      this.burstStartedAt = now;
      this.burstWritten = 0;
    }
    return this.burstWritten < Math.max(1, maxPagesPerRun);
  }

  private hasSeen(messageId: string): boolean {
    const at = this.seen.get(messageId);
    if (at === undefined) return false;
    if (Date.now() - at > SEEN_TTL_MS) {
      this.seen.delete(messageId);
      return false;
    }
    return true;
  }

  private markSeen(messageId: string): void {
    this.seen.set(messageId, Date.now());
    if (this.seen.size <= MAX_SEEN) return;
    // Insertion order is chronological, so the first key is the oldest entry.
    const oldest = this.seen.keys().next();
    if (!oldest.done) this.seen.delete(oldest.value);
  }
}
