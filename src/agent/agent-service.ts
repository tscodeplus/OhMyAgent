/**
 * Agent Service
 *
 * High-level interface for executing agent prompts.
 * Keeps the Agent alive across turns so pi-mono's built-in
 * state.messages provides native conversation continuity.
 */

import type { AgentFactory } from './agent-factory.js';
import type { AgentTurnContext } from './agent-factory.js';
import { i18n } from '../i18n/i18n-service.js';
import type { Agent } from '../pi-mono/agent/agent.js';
import type { AgentEvent, AgentMessage } from '../pi-mono/agent/types.js';
import { setSessionAgent, clearSessionAgent } from './agent-context.js';
import type { ReplyDispatcher, FooterConfig, AppServices } from '../app/types.js';
import type { SessionRepository } from '../memory/repositories/session-repository.js';
import type { MessageRepository } from '../memory/repositories/message-repository.js';
import type { EpisodeRepository } from '../memory/repositories/episode-repository.js';
import type { ToolRunRepository } from '../memory/repositories/tool-run-repository.js';
import type { MemorySummarizer } from '../memory/memory-summarizer.js';
import type { Logger } from 'pino';
import { generateId } from '../shared/ids.js';
import { EventBridge } from './event-bridge.js';
import type { ImageContent } from '../pi-mono/ai/types.js';
import type { VisionBridgeService } from '../vision-bridge/vision-bridge-service.js';
import { persistMessages } from './message-persister.js';
import { recoverFromOverflow } from './overflow-recovery.js';
import { waitForIdleWithTimeout } from '../shared/with-timeout.js';
import { subscribeToolRunAudit } from './tool-audit.js';
import { activeSkillFeedbackIds } from './skill-activator.js';
import { inferSatisfaction } from '../skills/skill-evolution/skill-metrics.js';
import type { HarnessServices } from '../harness/factory.js';
import type { FailureContext, ToolCallRecord, FailureSignal, ImprovementProposal, SkillStatsInfo } from '../harness/types.js';
import {
  generateSessionTitle,
  isPlaceholderTitle,
  parseSessionMetadata,
} from './session-title.js';

export interface AgentServiceOptions {
  sessionId?: string;
  chatId?: string;
  messageId?: string;
  systemPrompt?: string;
  tools?: any[];
  historyMessages?: Array<{ role: string; content: string | Array<{ type: string; text?: string }>; timestamp: number }>;
  images?: ImageContent[];
  /** If set, use this dispatcher instead of creating one via the factory. Used by channels. */
  replyDispatcherOverride?: ReplyDispatcher;
  /** Factory to create a fresh channel-specific dispatcher for followUp (/steer, /btw). */
  replyDispatcherFactory?: () => ReplyDispatcher;
  /** Channel identifier for channel-aware features (e.g. cron delivery, approval UI routing). */
  channel?: string;
  /** Operator identity of the message sender (e.g. Feishu open_id). Stored as
   *  the approval request's requester so approval callbacks can verify the
   *  clicker is the requester. */
  senderId?: string;
  /** Non-Feishu channel approval message sender. */
  channelApprovalSender?: import('./before-tool-call.js').BeforeToolCallDeps['channelApprovalSender'];
  /** Channel-specific Computer Use screenshot sender. */
  computerUseImageSender?: (image: { data: string; mimeType: string }) => Promise<string>;
  /** Additional tools to append to the agent's tool list. Used by channels for send_media etc. */
  extraTools?: any[];
  /** V2: agent ID for config-based model selection. Used by cron to use the creating agent's model. */
  agentId?: string;
  /** Cron permission snapshot: false removes Computer Use for this run. */
  computerUseAllowed?: boolean;
  /** Persist the user message BEFORE starting agent execution. When true,
   *  the raw input is written to the DB immediately so the frontend can
   *  display it via API fetch even if the SSE stream is disconnected
   *  (page refresh, tab switch) before the agent completes. */
  eagerPersistUserMessage?: boolean;
}

export interface AgentServicePersistenceOptions {
  sessionRepository: SessionRepository;
  messageRepository: MessageRepository;
  episodeRepository: EpisodeRepository;
  toolRunRepository?: ToolRunRepository;
  memorySummarizer: MemorySummarizer;
  /** Summarize every N messages per session (default: 10). */
  summarizeInterval?: number;
  /** Load up to N recent messages from DB when creating a new runtime after restart. 0 disables. */
  historyLoadCount?: number;
  /** Max estimated tokens for loaded history messages. 0 = no limit. */
  historyMaxTokens?: number;
  logger: Logger;
}

/**
 * Rough token count estimation. ASCII ≈ char/4, CJK/non-ASCII ≈ char/2.
 * Overestimates for CJK safety; accuracy ±30% is fine for a soft cap.
 */
function estimateTokens(content: string | Array<{ type: string; text?: string }>): number {
  const text = typeof content === 'string'
    ? content
    : content.map(b => b.text ?? '').join('');
  let tokens = 0;
  for (const ch of text) {
    tokens += ch.charCodeAt(0) > 127 ? 0.5 : 0.25;
  }
  return Math.ceil(tokens);
}

/** P1 M6: default wall-clock cap for a single agent turn (5 minutes). */
const DEFAULT_TURN_TIMEOUT_MS = 300_000;
/** P1 M6: grace period for an aborted turn to unwind before we abandon the
 *  wait (matches the orchestrator's 10s stopAgent settle window). */
const TURN_SETTLE_GRACE_MS = 10_000;

/**
 * Thrown when an agent turn exceeds the configured wall-clock cap.
 * Caught by execute()'s generic error path — cleanup, harness failure
 * detection, and queue unblocking all work as for any turn error.
 */
export class TurnTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnTimeoutError';
  }
}

export class AgentService {
  /** Sessions explicitly cleared by /new or /clear — skip history load on next message. */
  private clearedSessions = new Set<string>();

  /** Sessions whose auto-title generation is currently in flight. */
  private pendingTitles = new Set<string>();

  private runtimes = new Map<string, {
    agent: Agent;
    bridge: EventBridge | null;
    auditUnsubscribe?: () => void;
    persistedMessageCount: number;
    turnElapsed?: number;
    /** Agent message count at the start of the current turn. Tool-call
     *  extraction (completion metrics, harness failure context) only
     *  considers messages after this baseline, so historical failures
     *  are not re-analyzed. */
    turnMessageBaseline?: number;
    /** Message objects present when the turn started. Identity-based window
     *  for tool-call extraction: survives mid-turn context compression,
     *  which shrinks state.messages and would otherwise make a length
     *  baseline slice empty (missing the turn's metrics entirely). */
    turnBaselineMessages?: Set<AgentMessage>;
    turnContext: AgentTurnContext;
    channel?: string;
    /** Agent name captured from the dispatcher for metadata persistence. */
    agentName?: string;
    /** Footer display config captured from the dispatcher for metadata persistence. */
    footerConfig?: FooterConfig;
    /** Skill name activated for this turn (consumed by persistMessages on first assistant msg). */
    skillActivatedName?: string;
    /** Whether to persist tool call metadata (respects showToolCalls setting). */
    showToolCalls?: boolean;
  }>();

  private sessionAgentMap = new Map<string, string>();

  /** sessionId → feedbackId awaiting satisfaction inference from the user's
   *  next message (skill self-evolution feedback loop). */
  private pendingSatisfaction = new Map<string, string>();

  /** Last inferred user satisfaction per session, consumed by the harness
   *  failure context (userFeedback). */
  private sessionSatisfaction = new Map<string, 'satisfied' | 'dissatisfied' | null>();

  constructor(
    private factory: AgentFactory,
    private replyDispatcherFactory: (chatId: string, messageId?: string, agentId?: string) => ReplyDispatcher,
    private persistence?: AgentServicePersistenceOptions,
    /** Lazy factory — VisionBridgeService is only created on first image analysis. */
    private getVisionBridge?: () => VisionBridgeService | undefined,
    private imageMode: 'native_first' | 'bridge_only' | 'native_only' = 'native_first',
    private harness?: HarnessServices,
    /** Lazy accessor for AppServices (bootstrap servicesRef) — used to reach
     *  skillMetricsService for the skill self-evolution feedback loop. */
    private getServices?: () => AppServices | undefined,
    /** P1 M6: Max wall-clock time for a single agent turn (ms). 0 disables. */
    private turnTimeoutMs: number = DEFAULT_TURN_TIMEOUT_MS,
    /** Maximum retry attempts for transient provider/transport errors (0 disables). */
    private maxRetries: number = 2,
  ) {}

  /**
   * Execute a prompt — reuses the existing Agent for conversation continuity.
   * Creates a new Agent only on the first call or when the session changes.
   */
  async execute(
    input: string,
    options?: AgentServiceOptions,
  ): Promise<Agent> {
    const sessionId = options?.sessionId ?? 'default';
    let runtime = this.runtimes.get(sessionId);

    // ---- Skill self-evolution feedback loop: satisfaction inference ----
    // Runs before the runtime build so it only picks up entries left over
    // from a previous turn (same-turn activations are consumed at completion).
    // The activator Map has no cleanup of its own — take-and-delete here.
    const leftoverFeedback = activeSkillFeedbackIds.get(sessionId);
    if (leftoverFeedback) {
      this.pendingSatisfaction.set(sessionId, leftoverFeedback.feedbackId);
      activeSkillFeedbackIds.delete(sessionId);
    }
    // Infer the previous turn's user satisfaction from this new message.
    const pendingFeedbackId = this.pendingSatisfaction.get(sessionId);
    if (pendingFeedbackId) {
      const sat = inferSatisfaction(input);
      if (sat !== null) {
        this.sessionSatisfaction.set(sessionId, sat === 1 ? 'satisfied' : 'dissatisfied');
        try {
          this.getServices?.()?.skillMetricsService?.recordSatisfaction(pendingFeedbackId, sat);
        } catch (err) {
          // Non-fatal — best-effort metrics recording must never break the turn
          this.persistence?.logger?.debug({ err, sessionId }, 'recordSatisfaction failed — best-effort');
        }
        this.pendingSatisfaction.delete(sessionId);
      }
    }

    const agentIdFromSession = this.sessionAgentMap.get(sessionId);

    if (!runtime) {
      if (agentIdFromSession) {
        setSessionAgent(sessionId, agentIdFromSession);
      }

      // Load recent message history from DB on restart so the agent retains
      // conversation continuity across service restarts. Skip when the caller
      // already provided historyMessages explicitly, when the feature is
      // disabled (historyLoadCount: 0), or when the session was explicitly
      // cleared by /new or /clear.
      let historyMessages = options?.historyMessages;
      const wasCleared = this.clearedSessions.has(sessionId);
      if (wasCleared) this.clearedSessions.delete(sessionId);
      if (!historyMessages && this.persistence && sessionId !== 'default' && !wasCleared) {
        const limit = this.persistence.historyLoadCount ?? 0;
        const maxTokens = this.persistence.historyMaxTokens ?? 0;
        if (limit > 0) {
          try {
            const rows = this.persistence.messageRepository.findBySessionIdDesc(sessionId, limit);
            const parsed = rows.reverse().map(m => ({
              role: m.role,
              content: m.role === 'assistant'
                ? [{ type: 'text' as const, text: m.content }]
                : m.content,
              timestamp: new Date(m.created_at).getTime(),
            }));
            // Apply token cap: keep newest messages that fit within maxTokens.
            // Walk from newest to oldest, stop when budget is exceeded.
            if (maxTokens > 0) {
              let used = 0;
              const capped: typeof parsed = [];
              for (let i = parsed.length - 1; i >= 0; i--) {
                const tokens = estimateTokens(parsed[i].content);
                if (used + tokens > maxTokens) break;
                used += tokens;
                capped.unshift(parsed[i]);
              }
              historyMessages = capped;
            } else {
              historyMessages = parsed;
            }
          } catch {
            // Non-fatal — start with empty history if the DB read fails
            this.persistence?.logger?.debug({ sessionId }, 'History load failed — starting with empty history');
          }
        }
      }

      const turnContext: AgentTurnContext = {};
      runtime = {
        agent: this.factory.create({
          ...options,
          message: input,
          agentId: agentIdFromSession ?? options?.agentId,
          turnContext,
          historyMessages,
          maxRetries: this.maxRetries,
        }),
        bridge: null,
        persistedMessageCount: historyMessages?.length ?? 0,
        turnContext,
        channel: options?.channel,
      };
      if (this.persistence?.toolRunRepository) {
        runtime.auditUnsubscribe = this.subscribeToolRunAudit(
          runtime.agent,
          sessionId,
          this.persistence.toolRunRepository,
        );
      }
      this.runtimes.set(sessionId, runtime);
    } else if (options?.channel) {
      const previousAgent = runtime.agent;
      const preservedMessages = previousAgent.state.messages;
      runtime.auditUnsubscribe?.();
      const nextAgent = this.factory.create({
        ...options,
        message: input,
        agentId: agentIdFromSession ?? options?.agentId,
        turnContext: runtime.turnContext,
        maxRetries: this.maxRetries,
      });
      nextAgent.state.messages = preservedMessages;
      runtime.agent = nextAgent;
      if (this.persistence?.toolRunRepository) {
        runtime.auditUnsubscribe = this.subscribeToolRunAudit(
          runtime.agent,
          sessionId,
          this.persistence.toolRunRepository,
        );
      }
    }

    // Create a fresh dispatcher and bridge for each turn (new card per message)
    runtime.bridge?.stop();
    const dispatcher = options?.replyDispatcherOverride
      ?? this.replyDispatcherFactory(options?.chatId ?? '', options?.messageId, agentIdFromSession);
    runtime.turnContext.chatId = options?.chatId;
    runtime.turnContext.messageId = options?.messageId;
    if (options?.channel) runtime.channel = options.channel;
    runtime.turnContext.replyDispatcher = dispatcher;
    runtime.turnContext.replyDispatcherFactory = options?.replyDispatcherFactory;
    // Capture footer config and agent name from the dispatcher for metadata
    // persistence. These snapshot values at message-send time so historical
    // messages retain their display even after settings change.
    const dispatcherAny = dispatcher as unknown as Record<string, unknown>;
    runtime.footerConfig = dispatcherAny.footerConfig as FooterConfig | undefined;
    if (!runtime.agentName && dispatcherAny.agentName) {
      runtime.agentName = dispatcherAny.agentName as string;
    }
    // Capture showToolCalls for persistence gating — when off, skip tool
    // call metadata so tool cards don't appear on page refresh.
    runtime.showToolCalls = dispatcherAny.showToolCalls !== false;
    // Clear cached approval session so each turn gets a fresh tracker
    (runtime.turnContext as Record<string, unknown>).approvalSession = undefined;
    runtime.bridge = new EventBridge(dispatcher, this.persistence?.logger);
    runtime.bridge.start(runtime.agent);

    // Defer skill activation dispatch until after agent_start (turn_start SSE),
    // so the frontend has already created the message bubble before the skill
    // text_delta arrives. EventBridge dispatches pendingSkillName after onStart.
    const skillName = runtime.turnContext.activatedSkillName;
    if (skillName) {
      // Respect showSkillCalls setting for both SSE dispatch AND persistence.
      // When off, skip both so the notification doesn't appear on refresh either.
      if (dispatcherAny.showSkillCalls !== false) {
        runtime.bridge.pendingSkillName = skillName;
        runtime.skillActivatedName = skillName;
      }
      // Clear turnContext so it only fires once per turn
      runtime.turnContext.activatedSkillName = undefined;
    }

    const agent = runtime.agent;

    // Capture turn start for elapsed-time computation in the pre-complete
    // callback (which fires before agent.prompt() returns).
    const turnStart = Date.now();

    // Baseline for the current turn's message window — tool-call extraction
    // (completion metrics, harness failure analysis) only considers messages
    // added after this point, so historical failures are not re-analyzed.
    runtime.turnMessageBaseline = agent.state.messages.length;
    runtime.turnBaselineMessages = new Set(agent.state.messages);

    // Wire pre-complete callback: persist messages BEFORE the SSE "done"
    // event is sent so the frontend refetch always sees the latest turn.
    if (this.persistence && sessionId) {
      runtime.bridge.setPreCompleteCallback(async () => {
        // Compute elapsed now — agent_end has already fired so the turn is over.
        runtime.turnElapsed = Date.now() - turnStart;
        await this.persistMessages(agent, sessionId, runtime);
      });
    }

    try {
      if (this.persistence && sessionId) {
        this.ensureSession(sessionId);
        // Auto-title the conversation from its first user message. Fire-and-forget:
        // never blocks or breaks the turn, and only writes when the current title
        // is still a placeholder (user renames always win).
        this.maybeAutoTitle(sessionId, input, agent);
      }

      // Eagerly persist the user message so the frontend can show it
      // immediately via API fetch even if the user refreshes or switches
      // sessions while the agent is still generating a reply.
      if (this.persistence && sessionId && options?.eagerPersistUserMessage) {
        try {
          const now = Date.now();
          this.persistence.messageRepository.create({
            id: generateId(),
            session_id: sessionId,
            role: 'user',
            content: input,
            metadata: null,
            created_at: now,
          });
          // Bump the counter so persistMessages() at turn end skips this
          // message (which will have been added to agent.state.messages
          // by agent.prompt() with a different internal ID).
          runtime.persistedMessageCount++;
        } catch {
          // Non-fatal — persistMessages() at turn end will persist it
          this.persistence?.logger?.debug({ sessionId }, 'Pre-persist user message failed — will be persisted at turn end');
        }
      }

      // Apply skill activation data for this turn, then clear immediately.
      // The reminder only applies to the current message; turnContext persists
      // across turns for the same session.
      let finalInput = runtime.turnContext.effectiveMessage ?? input;
      runtime.turnContext.effectiveMessage = undefined;

      // Vision Bridge: analyze images for text-only models
      // Respects image mode: native_first (default), bridge_only, native_only
      let finalImages = options?.images;
      if (finalImages?.length) {
        const model = agent.state.model as { input?: string[] } | undefined;
        if (model) {
          const modelSupportsImages = Array.isArray(model.input) && model.input.includes('image');

          if (this.imageMode === 'native_only') {
            // Always pass images through natively — skip any bridging
          } else if (this.imageMode === 'bridge_only') {
            // Always bridge — regardless of model capability
            const vb = this.getVisionBridge?.();
            if (vb) {
              const result = await vb.bridge(finalInput, finalImages, model as import('@earendil-works/pi-ai').Model<any>, { forceBridge: true });
              finalInput = result.text;
              finalImages = undefined;
            }
          } else {
            // native_first: prefer native, bridge only as fallback for text-only models
            if (modelSupportsImages) {
              // Model supports images natively — pass through directly
            } else {
              // Text-only model — use vision bridge if available
              const vb = this.getVisionBridge?.();
              if (vb) {
                const result = await vb.bridge(finalInput, finalImages, model as import('@earendil-works/pi-ai').Model<any>, { forceBridge: true });
                finalInput = result.text;
                finalImages = undefined;
              }
            }
          }
        }
      }

      // Run the prompt — Agent.state.messages provides conversation continuity
      // P1 M6: turn-level watchdog — a provider stream or tool that never
      // settles (network hang, provider fault) must not block this session's
      // queue forever. On timeout we abort via the agent's own AbortController
      // (the same chain /stop uses — no duplicate abort mechanism), then give
      // the loop a bounded grace period to unwind and dispatch the failure
      // card before failing the turn.
      await this.runTurnWithTimeout(agent, finalInput, finalImages, runtime, sessionId);
      runtime.turnElapsed = Date.now() - turnStart;

      // v9: Context overflow recovery (pi-style)
      await this._recoverFromOverflow(agent, runtime, sessionId);

      // Persist messages to database (backup, not the source of truth)
      if (this.persistence && sessionId) {
        await this.persistMessages(agent, sessionId, runtime);
        this.maybeSummarize(sessionId).catch(err => {
          this.persistence?.logger.warn({ err }, 'Background summarization failed');
        });
      }

      // ---- Skill self-evolution feedback loop: completion metrics ----
      try {
        const extracted = this.extractToolCalls(
          this.currentTurnMessages(runtime),
        );
        const feedbackEntry = activeSkillFeedbackIds.get(sessionId);
        if (feedbackEntry) {
          // success stays null — the user's next message infers satisfaction
          this.getServices?.()?.skillMetricsService?.recordCompletion(
            feedbackEntry.feedbackId,
            null,
            Date.now() - feedbackEntry.startTime,
            extracted.toolCalls,
          );
          // Keep the feedbackId alive for satisfaction inference on the next
          // user message — the "closed loop" half of the feedback cycle.
          this.pendingSatisfaction.set(sessionId, feedbackEntry.feedbackId);
          activeSkillFeedbackIds.delete(sessionId);
        }
        if (this.harness) {
          this.harness.autoApplyMonitor.onActivationComplete(
            runtime.turnContext?.activatedSkillId ?? null,
            (agent as any).state?.agentId || 'default',
            { success: true, errorCount: extracted.errorCount, durationMs: runtime.turnElapsed ?? 0 },
          );
        }
      } catch (err) {
        // Non-fatal — best-effort metrics recording must never break the turn
        this.persistence?.logger?.debug({ err, sessionId }, 'Skill feedback completion failed — best-effort');
      }

      // ---- Self-Harness: failure detection and optimization ----
      if (this.harness) {
        this.detectAndOptimize(runtime, sessionId, null).catch(err => {
          this.persistence?.logger.warn({ err }, 'Harness optimization failed');
        });
      }

      return agent;
    } catch (error) {
      runtime.bridge?.stop();
      runtime.auditUnsubscribe?.();
      this.runtimes.delete(sessionId);
      this.persistence?.logger.error({ err: error }, 'agent execute error');

      // ---- Skill self-evolution feedback loop: failure completion ----
      // Same backfill as the success path; runtime.turnElapsed may not have
      // been updated here, so the duration falls back to Date.now() - turnStart.
      try {
        const extracted = this.extractToolCalls(
          this.currentTurnMessages(runtime),
        );
        const feedbackEntry = activeSkillFeedbackIds.get(sessionId);
        if (feedbackEntry) {
          this.getServices?.()?.skillMetricsService?.recordCompletion(
            feedbackEntry.feedbackId,
            null,
            Date.now() - feedbackEntry.startTime,
            extracted.toolCalls,
          );
          this.pendingSatisfaction.set(sessionId, feedbackEntry.feedbackId);
          activeSkillFeedbackIds.delete(sessionId);
        }
        if (this.harness) {
          this.harness.autoApplyMonitor.onActivationComplete(
            runtime.turnContext?.activatedSkillId ?? null,
            (agent as any).state?.agentId || 'default',
            { success: false, errorCount: extracted.errorCount, durationMs: Date.now() - turnStart },
          );
        }
      } catch (err) {
        // Non-fatal — best-effort metrics recording must never break the turn
        this.persistence?.logger?.debug({ err, sessionId }, 'Skill feedback failure completion failed — best-effort');
      }

      // ---- Self-Harness: detect failure from error ----
      if (this.harness) {
        this.detectAndOptimize(runtime, sessionId, error).catch(err => {
          this.persistence?.logger.warn({ err }, 'Harness optimization failed');
        });
      }

      throw error;
    }
  }

  /**
   * Run one agent turn under the P1 M6 turn-level watchdog.
   *
   * On timeout: abort() via the agent's own AbortController (same chain as
   * /stop), then wait a bounded grace period for agent_end to fire — that
   * dispatches the failure card and runs the pre-complete persistMessages
   * callback. A tool stuck in a hung operation may never unwind; in that
   * case the error card is sent explicitly and the turn fails regardless,
   * so the session queue can move on.
   */
  private async runTurnWithTimeout(
    agent: Agent,
    input: string,
    images: ImageContent[] | undefined,
    runtime: NonNullable<ReturnType<typeof this.runtimes.get>>,
    sessionId?: string,
  ): Promise<void> {
    const timeoutMs = this.turnTimeoutMs;
    if (timeoutMs <= 0) {
      await agent.prompt(input, images);
      return;
    }

    const turnPromise = agent.prompt(input, images);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let resolveTimeout: ((value: boolean) => void) | undefined;

    // Activity-based watchdog: the wall-clock cap applies to *inactivity*
    // rather than the whole turn. Long tool sequences and multi-step research
    // keep the turn alive as long as the agent keeps emitting progress; a
    // genuinely hung provider stream or tool still trips the cap after
    // `timeoutMs` of silence. The listener is synchronous and never throws,
    // so it adds no observable latency to event dispatch.
    const armTimer = () => {
      if (timedOut) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        resolveTimeout?.(true);
      }, timeoutMs);
    };
    const ACTIVITY_EVENTS = new Set<AgentEvent['type']>([
      'turn_start',
      'message_start',
      'message_update',
      'message_end',
      'tool_execution_start',
      'tool_execution_end',
      'turn_end',
    ]);
    const unsubscribeActivity = agent.subscribe((event) => {
      if (ACTIVITY_EVENTS.has(event.type)) armTimer();
    });
    try {
      const timeoutPromise = new Promise<boolean>((resolve) => {
        resolveTimeout = resolve;
      });
      armTimer();
      timedOut = await Promise.race([
        turnPromise.then(() => false),
        timeoutPromise,
      ]);
    } finally {
      unsubscribeActivity();
      if (timer !== undefined) clearTimeout(timer);
    }

    if (!timedOut) return;

    const message = `Agent turn timed out after ${timeoutMs / 1000}s`;
    this.persistence?.logger?.warn({ err: new TurnTimeoutError(message), sessionId }, 'Agent turn timed out');
    // Consume any late rejection — the abort path below already handled the outcome.
    turnPromise.catch(() => {});

    agent.abort();
    const settled = await waitForIdleWithTimeout(
      () => agent.waitForIdle(),
      TURN_SETTLE_GRACE_MS,
    );
    if (!settled) {
      this.persistence?.logger?.warn(
        { sessionId },
        'Agent did not settle within grace period after turn timeout — abandoning wait (agent may be stuck in a hung tool)',
      );
      // agent_end will never fire — deliver the error card ourselves.
      try {
        await runtime.turnContext.replyDispatcher?.onError(new Error(message));
      } catch {
        // Best-effort — the turn is already failing.
      }
    }
    throw new TurnTimeoutError(message);
  }

  /**
   * Abort the current agent execution, if any.
   *
   * Waits for the agent to become idle before returning so that the
   * pre-complete callback (persistMessages) has finished. This ensures
   * that messages from the aborted turn are in the database before
   * any caller (e.g. /stop handler) persists follow-up messages —
   * preserving correct chronological order.
   */
  async abort(sessionId?: string): Promise<void> {
    const settle = async (runtime: NonNullable<ReturnType<typeof this.runtimes.get>>, sessionKey?: string): Promise<void> => {
      // P1 M6: bounded settle — a hung tool may never unwind, so /stop must
      // not hang the command handler (and with it the session queue).
      const settled = await waitForIdleWithTimeout(
        () => runtime.agent.waitForIdle(),
        TURN_SETTLE_GRACE_MS,
      );
      if (!settled) {
        this.persistence?.logger?.warn(
          { sessionId: sessionKey },
          'Agent did not settle within grace period during abort — abandoning wait',
        );
      }
    };

    if (sessionId) {
      const runtime = this.runtimes.get(sessionId);
      if (!runtime) return;
      runtime.agent.abort();
      // waitForIdle resolves after all agent_end listeners (including
      // the pre-complete persistMessages callback) have settled.
      await settle(runtime, sessionId);
      return;
    }

    for (const runtime of this.runtimes.values()) {
      runtime.agent.abort();
    }
    // Wait for all runtimes to settle
    await Promise.allSettled(
      Array.from(this.runtimes.values()).map(r => settle(r)),
    );
  }

  /**
   * Reject all pending approval requests for a given session.
   * Called by /stop before aborting the agent, and by steer() to clear
   * approvals when a new message supersedes the current turn.
   */
  rejectPendingApprovals(sessionId: string, reason?: 'stopped_by_user' | 'steered'): number {
    return this.factory.rejectPendingApprovals(sessionId, reason);
  }

  /**
   * Resolve the first (oldest) pending approval for a session.
   * Called by slash commands (/approve, /deny) in channels without
   * interactive approval UI (e.g. WeChat).
   * Returns false if no pending approvals exist for the session.
   */
  resolveFirstPendingApproval(sessionId: string, decision: string): boolean {
    return this.factory.resolveFirstPendingApproval(
      sessionId,
      decision as import('../app/types.js').ApprovalDecisionType,
    );
  }

  /**
   * Resolve ALL pending approvals for a session with the given decision.
   * Called by /approve session and /approve always.
   * Returns the number of approvals resolved.
   */
  resolveAllPendingApprovals(sessionId: string, decision: string): number {
    return this.factory.resolveAllPendingApprovals(
      sessionId,
      decision as import('../app/types.js').ApprovalDecisionType,
    );
  }

  /**
   * Resolve a pending approval request by its ID.
   * Called by channel callback handlers (inline keyboards, card actions).
   * Returns true if the request was found and resolved, false if it was
   * already handled (duplicate callback).
   */
  resolveApproval(requestId: string, decision: string): boolean {
    return this.factory.resolveApproval(
      requestId,
      decision as import('../app/types.js').ApprovalDecisionType,
    );
  }

  /**
   * Resolve a pending user question with the given answer.
   * Returns false if the request was already handled (duplicate callback).
   */
  resolveUserQuestion(requestId: string, answer: string): boolean {
    return this.factory.resolveUserQuestion(requestId, answer);
  }

  /**
   * Resolve the first pending user question for a session.
   * Returns false if no pending questions exist.
   */
  resolveFirstPendingQuestion(sessionId: string, answer: string): boolean {
    return this.factory.resolveFirstPendingQuestion(sessionId, answer);
  }

  /**
   * Reject all pending user questions for a session.
   * Called when a new message arrives (steer) or the agent is stopped.
   */
  rejectPendingQuestions(sessionId: string): number {
    return this.factory.rejectPendingQuestions(sessionId);
  }

  setSessionAgentId(sessionId: string, agentId: string): void {
    this.sessionAgentMap.set(sessionId, agentId);
    setSessionAgent(sessionId, agentId);
  }

  /**
   * Queue a steering message for mid-execution course correction.
   * Clears any previously queued steering messages and auto-rejects pending
   * approvals. Order matters: the steer message MUST be queued BEFORE
   * resolving approvals, so the agent loop finds it when it resumes.
   */
  steer(sessionId: string, message: string): boolean {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return false;
    // 1. Clear any previous steering message
    runtime.agent.clearSteeringQueue();
    // 2. Queue the new message BEFORE unblocking the agent via reject
    runtime.agent.steer({
      role: 'user',
      content: [{ type: 'text', text: message }],
      timestamp: Date.now(),
    });
    // 3. Now resolve pending approvals — the message is already in the
    //    steering queue, so the agent loop will find it when it resumes
    this.rejectPendingApprovals(sessionId, 'steered');
    // 4. Also reject any pending user questions (ask_user_question tool)
    this.rejectPendingQuestions(sessionId);
    return true;
  }

  /**
   * Swap the current ReplyDispatcher / EventBridge to a new card.
   * Finalizes the old card (preserving generated content), then creates
   * a fresh dispatcher that will create a new card when streaming starts.
   *
   * Only the card is swapped — the agent keeps running. Callers should
   * follow up with steer() to inject a message into the running agent.
   */
  async swapCard(sessionId: string, replyToMessageId?: string): Promise<boolean> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime || !runtime.turnContext.chatId) return false;

    // Update old dispatcher's model from the agent's actual state model
    // before finalizing the card. Without this, the footer shows the global
    // default model instead of the agent-specific model (swapCard fires
    // before EventBridge.agent_end, which is where setModel normally runs).
    const stateModel = runtime.agent.state.model;
    if (stateModel?.provider && stateModel?.id) {
      try {
        runtime.turnContext.replyDispatcher?.setModel(
          `${stateModel.provider}/${stateModel.id}`,
        );
      } catch {
        this.persistence?.logger?.debug({ sessionId }, 'swapCard: setModel not supported by dispatcher');
      }
    }

    // Finalize old card so generated content is preserved
    try {
      await runtime.turnContext.replyDispatcher?.onComplete();
    } catch {
      this.persistence?.logger?.debug({ sessionId }, 'swapCard: best-effort finalization failed');
    }

    // Stop old EventBridge
    runtime.bridge?.stop();

    // Create new ReplyDispatcher (new card) replying to the given message
    const agentId = this.sessionAgentMap.get(sessionId);
    const dispatcher = this.replyDispatcherFactory(
      runtime.turnContext.chatId,
      replyToMessageId,
      agentId,
    );
    runtime.turnContext.replyDispatcher = dispatcher;

    // Kick off the new card immediately — the agent is already running so
    // there will not be another agent_start event to trigger onStart().
    await dispatcher.onStart();

    // New EventBridge bound to the fresh dispatcher
    runtime.bridge = new EventBridge(dispatcher, this.persistence?.logger);
    runtime.bridge.start(runtime.agent);

    return true;
  }

  /**
   * Register a one-shot callback that fires when the current agent run ends.
   * Used for cleanup (e.g. removing reaction emoji from /steer messages).
   */
  onNextAgentEnd(sessionId: string, callback: () => void): void {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    const unsub = runtime.agent.subscribe((event) => {
      if (event.type === 'agent_end') {
        unsub();
        callback();
      }
    });
  }

  /**
   * Queue a follow-up message that runs on its own card after the agent becomes idle.
   * Does NOT use the agent's internal followUp queue (which would share the current card).
   * Instead waits for idle, sets up a fresh EventBridge, and calls agent.prompt() directly.
   */
  async followUp(sessionId: string, message: string, replyToMessageId?: string): Promise<boolean> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return false;
    const agentId = this.sessionAgentMap.get(sessionId);
    this.runOnIdleCard(runtime, message, replyToMessageId, agentId, sessionId);
    return true;
  }

  private async runOnIdleCard(
    runtime: NonNullable<ReturnType<typeof this.runtimes.get>>,
    message: string,
    replyToMessageId?: string,
    agentId?: string,
    sessionId?: string,
  ): Promise<void> {
    // P1 M6: bounded settle — a hung turn must not hang /btw dispatch either.
    const settled = await waitForIdleWithTimeout(
      () => runtime.agent.waitForIdle(),
      TURN_SETTLE_GRACE_MS,
    );
    if (!settled) {
      this.persistence?.logger?.warn(
        { sessionId },
        'waitForIdle did not settle within grace period in followUp — abandoning',
      );
      return;
    }
    runtime.bridge?.stop();
    const dispatcher = runtime.turnContext.replyDispatcherFactory
      ? runtime.turnContext.replyDispatcherFactory()
      : this.replyDispatcherFactory(
          runtime.turnContext.chatId ?? '',
          replyToMessageId,
          agentId,
        );
    runtime.turnContext.replyDispatcher = dispatcher;
    runtime.bridge = new EventBridge(dispatcher, this.persistence?.logger);
    runtime.bridge.start(runtime.agent);
    runtime.agent.prompt(message).catch(() => {
      this.persistence?.logger?.debug({ sessionId }, 'followUp prompt completed with error');
    });
  }

  /**
   * Reset the agent state (clear conversation history) for a session.
   * The Agent instance stays alive; only its internal message buffer is cleared.
   */
  reset(sessionId: string): boolean {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return false;
    runtime.agent.reset();
    runtime.persistedMessageCount = 0;
    this.sessionAgentMap.delete(sessionId);
    clearSessionAgent(sessionId);
    this.clearedSessions.add(sessionId);
    return true;
  }

  /**
   * Destroy the runtime for a session so the next execute() creates a fresh Agent.
   * Cleans up bridge, audit subscriptions, and removes the runtime from the map.
   */
  destroyRuntime(sessionId: string): boolean {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return false;
    runtime.bridge?.stop();
    runtime.auditUnsubscribe?.();
    this.runtimes.delete(sessionId);
    this.clearedSessions.add(sessionId);
    return true;
  }

  /**
   * Whether an agent is currently executing a prompt.
   */
  isRunning(sessionId?: string): boolean {
    if (sessionId) {
      return this.runtimes.get(sessionId)?.agent.state?.isStreaming ?? false;
    }
    return Array.from(this.runtimes.values()).some(
      (runtime) => runtime.agent.state?.isStreaming ?? false,
    );
  }

  /**
   * Persist agent messages to the database.
   */
  private async persistMessages(
    agent: Agent,
    sessionKey: string,
    runtime: { persistedMessageCount: number; turnElapsed?: number; footerConfig?: FooterConfig; agentName?: string },
  ): Promise<void> {
    const { messageRepository, logger } = this.persistence!;
    await persistMessages({
      agent,
      sessionKey,
      runtime,
      messageRepository,
      logger,
      ensureSession: (key) => this.ensureSession(key),
    });
  }

  /**
   * Auto-generate a session title from the first user message, reusing the
   * conversation's own model. Fire-and-forget; skips when the session already
   * has a real title (placeholder-only sessions get titled from their FIRST
   * user message so pre-upgrade "New Chat/新对话" rows also improve).
   */
  private maybeAutoTitle(sessionKey: string, input: string, agent: Agent): void {
    if (sessionKey === 'default') return;
    if (this.pendingTitles.has(sessionKey)) return;
    const { sessionRepository, messageRepository, logger } = this.persistence!;

    const session = sessionRepository.findById(sessionKey);
    if (!session) return;
    const metadata = parseSessionMetadata(session.metadata);
    if (!isPlaceholderTitle(typeof metadata.title === 'string' ? metadata.title : undefined)) {
      return;
    }

    this.pendingTitles.add(sessionKey);
    void (async () => {
      try {
        // Fresh session → title from this message. Older placeholder sessions
        // → title from their first user message instead.
        let source = input;
        const earliest = messageRepository.findBySessionId(sessionKey, 50);
        if (earliest.length > 0) {
          const firstUser = earliest.find((m) => m.role === 'user');
          if (!firstUser) return; // No user message persisted — nothing to title from
          source = firstUser.content;
        }

        // Resolve the provider API key the same way the agent loop does
        // (agent.getApiKey covers custom providers → provider_keys → piAi
        // apiKey). The compat completeSimple() used by generateSessionTitle
        // only auto-injects keys for well-known env vars, so custom providers
        // (e.g. agnes) would otherwise fail and silently fall back to the
        // user's first message as the title.
        const state = agent.state as { model?: { provider?: string; apiKey?: string } };
        const model = state.model;
        let apiKey: string | undefined = model?.apiKey;
        if (model?.provider && agent.getApiKey) {
          const resolved = await agent.getApiKey(model.provider);
          if (resolved) apiKey = resolved;
        }

        const title = await generateSessionTitle({ model, message: source, apiKey, logger });
        if (!title) return;

        // Re-check before writing: a manual rename that landed while the LLM
        // was running must never be overwritten.
        const current = sessionRepository.findById(sessionKey);
        if (!current) return;
        const currentMeta = parseSessionMetadata(current.metadata);
        if (!isPlaceholderTitle(typeof currentMeta.title === 'string' ? currentMeta.title : undefined)) {
          return;
        }

        sessionRepository.update(sessionKey, {
          metadata: JSON.stringify({ ...currentMeta, title }),
        });
        logger.info({ sessionKey, title }, 'Session title auto-generated');
      } catch (err) {
        logger.debug({ err, sessionKey }, 'Session title generation skipped');
      } finally {
        this.pendingTitles.delete(sessionKey);
      }
    })();
  }

  /**
   * Trigger summarization when the session accumulates enough new messages.
   */
  private async maybeSummarize(sessionKey: string): Promise<void> {
    const { messageRepository, episodeRepository, memorySummarizer, logger, summarizeInterval } = this.persistence!;
    const interval = summarizeInterval ?? 10;

    const totalMessages = messageRepository.countBySessionId(sessionKey);
    const existingEpisodes = episodeRepository.findBySessionId(sessionKey).length;

    const expectedSummaries = Math.floor(totalMessages / interval);

    if (expectedSummaries > existingEpisodes) {
      logger.info(
        { sessionKey, totalMessages, existingEpisodes, expectedSummaries },
        'Triggering session summarization',
      );
      const channel = this.runtimes.get(sessionKey)?.channel;
      await memorySummarizer.summarizeSession(sessionKey, { channel });
    }
  }

  /** v9: Check for context overflow and recover via compression + retry. */
  /** v9: Check for context overflow and recover via compression + retry. */
  private async _recoverFromOverflow(
    agent: Agent,
    runtime: NonNullable<ReturnType<typeof this.runtimes.get>>,
    sessionId?: string,
  ): Promise<void> {
    if (!sessionId) return;
    const compressCfg = this.factory.getAutoCompressConfig?.();
    if (!compressCfg) return;
    const logger = this.persistence?.logger;
    if (!logger) return;

    await recoverFromOverflow({
      agent,
      sessionId,
      compressCfg,
      logger,
      onRetryPersist: async () => {
        if (this.persistence && sessionId) {
          await this.persistMessages(agent, sessionId, runtime);
        }
      },
    });
  }

  private ensureSession(sessionKey: string): void {
    const { sessionRepository } = this.persistence!;
    const existingSession = sessionRepository.findById(sessionKey);
    if (!existingSession) {
      sessionRepository.create({
        id: sessionKey,
        chat_id: sessionKey,
        user_id: 'unknown',
      });
    } else {
      sessionRepository.touch(sessionKey);
    }
  }

  private subscribeToolRunAudit(
    agent: Agent,
    sessionId: string,
    toolRunRepository: ToolRunRepository,
  ): () => void {
    return subscribeToolRunAudit(agent, sessionId, toolRunRepository);
  }

  /**
   * Messages added since the current turn started.
   *
   * Uses the object-identity set captured at turn start instead of a length
   * baseline: mid-turn context compression replaces state.messages with a
   * shorter array, so `slice(baseline)` would return nothing and the turn's
   * tool calls would vanish from completion metrics and harness analysis.
   * Compression keeps the same message object references for the retained
   * tail (only the array and the dropped prefix change), so identity
   * filtering survives it; without compression it matches the slice exactly.
   */
  private currentTurnMessages(
    runtime: NonNullable<ReturnType<typeof this.runtimes.get>>,
  ): unknown[] {
    const baselineMessages = runtime.turnBaselineMessages;
    if (baselineMessages) {
      return runtime.agent.state.messages.filter(m => !baselineMessages.has(m));
    }
    return runtime.agent.state.messages.slice(runtime.turnMessageBaseline ?? 0);
  }

  /**
   * Extract tool calls (and the error count) from agent state messages.
   * Shared by completion metrics backfill and the harness failure context.
   * Callers slice to `runtime.turnMessageBaseline` to only analyze the
   * current turn — otherwise historical failures get re-analyzed.
   */
  private extractToolCalls(
    messages: unknown[],
  ): {
    toolCalls: ToolCallRecord[];
    errors: Array<{ toolName: string; message: string; timestamp: number }>;
    errorCount: number;
  } {
    const toolCalls: ToolCallRecord[] = [];
    const errors: Array<{ toolName: string; message: string; timestamp: number }> = [];

    for (const rawMsg of messages) {
      const msg = rawMsg as any;
      if (msg.role !== 'toolResult') continue;
      const contentArr = Array.isArray(msg.content)
        ? msg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text || '').join('\n')
        : typeof msg.content === 'string'
          ? msg.content
          : '';
      const isError = msg.isError === true;
      toolCalls.push({
        name: msg.toolName ?? 'unknown',
        args: msg.details ?? {},
        result: contentArr,
        isError,
        errorMessage: isError ? contentArr.slice(0, 200) : undefined,
        timestamp: msg.timestamp ?? Date.now(),
      });
      if (isError) {
        errors.push({
          toolName: msg.toolName ?? 'unknown',
          message: contentArr.slice(0, 200),
          timestamp: msg.timestamp ?? Date.now(),
        });
      }
    }
    return { toolCalls, errors, errorCount: errors.length };
  }

  private async detectAndOptimize(
    runtime: NonNullable<ReturnType<typeof this.runtimes.get>>,
    sessionId: string,
    error: unknown,
  ): Promise<void> {
    const harness = this.harness!;

    // Build FailureContext from runtime state — only the current turn's
    // messages (post-baseline) so historical failures are not re-analyzed.
    const { toolCalls, errors } = this.extractToolCalls(
      this.currentTurnMessages(runtime),
    );

    // Historical usage stats for the active skill (when metrics are
    // reachable), injected so the diagnosis LLM can reason with data
    // beyond the single failing session.
    const skillId = runtime.turnContext?.activatedSkillId;
    let skillStats: SkillStatsInfo | undefined;
    if (skillId) {
      try {
        const stats = this.getServices?.()?.skillMetricsService?.getStats(skillId);
        if (stats) {
          skillStats = {
            totalActivations: stats.totalActivations,
            successRate: stats.successRate,
            avgDurationMs: stats.avgDurationMs,
            topTools: stats.topTools,
          };
        }
      } catch (statsErr) {
        // Non-fatal — stats are a nice-to-have for the diagnosis LLM
        this.persistence?.logger?.debug({ err: statsErr, sessionId }, 'skillStats lookup failed — best-effort');
      }
    }

    const failureContext: FailureContext = {
      sessionId,
      skillId,
      skillStats,
      agentId: (runtime.agent as any).state?.agentId || 'default',
      // effectiveMessage carries the user's task with the $skill-id prefix
      // stripped; falls back to the original input.
      taskMessage: runtime.turnContext?.effectiveMessage ?? '',
      toolCalls,
      errors,
      userFeedback: this.sessionSatisfaction.get(sessionId) ?? null,
      durationMs: runtime.turnElapsed ?? 0,
      terminatedEarly: error !== null,
      agentEndReason: error ? 'error' : 'complete',
    };

    // Step 1: Detect failure
    const signal = harness.failureDetector.detect(failureContext);
    if (!signal || !signal.detected) return;

    // Step 2: Check rate limits + cooldown
    if (!harness.rateLimiter.canTrigger(
      failureContext.skillId,
      failureContext.agentId,
      signal.pattern,
    )) return;

    // Step 3: Optimize (async, non-blocking)
    try {
      const proposal = await harness.optimizer.optimize(failureContext);
      if (!proposal) return;

      // Step 4: Evaluate approval policy
      const { action, autoRollback } = harness.approvalPolicy.evaluate(proposal, {
        skillId: failureContext.skillId,
        agentId: failureContext.agentId,
        pattern: signal.pattern,
      });

      // Step 5: Act based on policy
      if (action === 'skip') return;

      if (action === 'auto_apply') {
        // Daily cap on auto-applies — once exhausted, escalate to asking
        // the user instead of silently applying more changes.
        if (!harness.rateLimiter.canAutoApply()) {
          await this.requestHarnessApproval(harness, runtime, proposal, signal);
          return;
        }
        const result = await harness.skillEditor.apply(proposal);
        if (result.success && result.commitHash && autoRollback) {
          harness.autoApplyMonitor.watch(
            proposal.id,
            failureContext.skillId ?? null,
            failureContext.agentId ?? null,
            autoRollback,
            result.commitHash,
          );
          harness.rateLimiter.recordAutoApply();
        }
        return;
      }

      // require_approval: notify via ReplyDispatcher
      await this.requestHarnessApproval(harness, runtime, proposal, signal);
    } catch (optErr) {
      // Optimization failed — log but never throw (non-blocking)
      this.persistence?.logger.warn({ err: optErr }, 'Harness optimization step failed');
    }
  }

  /** Present a proposal for user approval and apply it on approval / edit. */
  private async requestHarnessApproval(
    harness: NonNullable<AgentService['harness']>,
    runtime: NonNullable<ReturnType<typeof this.runtimes.get>>,
    proposal: ImprovementProposal,
    signal: FailureSignal,
  ): Promise<void> {
    const dispatcher = runtime.turnContext.replyDispatcher;
    if (!dispatcher?.requestHarnessApproval) {
      this.persistence?.logger.warn(
        { proposalId: proposal.id },
        'Harness proposal requires approval but channel does not support it — skipping',
      );
      return;
    }

    const interaction = {
      id: proposal.id,
      type: 'harness_improvement' as const,
      title: proposal.title,
      failureSummary: signal.reason,
      detail: proposal.summary,
      diff: proposal.diff,
      impact: {
        scope: proposal.affectedScope,
        riskLevel: proposal.regressionRisk,
        expectedEffect: proposal.expectedEffect,
      },
      actions: [
        { id: 'approve', label: i18n.t('harness:actions.approveApply'), style: 'primary' as const },
        { id: 'edit', label: i18n.t('harness:actions.editApply'), style: 'default' as const, inputField: { placeholder: i18n.t('harness:actions.editPlaceholder'), multiline: true, defaultValue: proposal.diff.after } },
        { id: 'reject', label: i18n.t('harness:actions.reject'), style: 'danger' as const },
        { id: 'dismiss', label: i18n.t('harness:actions.ignore'), style: 'default' as const },
      ],
    };

    const result = await dispatcher.requestHarnessApproval(interaction, 120_000);

    if (result.decision === 'approve') {
      await harness.skillEditor.apply(proposal);
    } else if (result.decision === 'edit') {
      // Apply the user's edited version when provided; fall back to the
      // original diff for channels that only signal "edit" without a value.
      const editedProposal =
        typeof result.editedValue === 'string' && result.editedValue.length > 0
          ? { ...proposal, diff: { ...proposal.diff, after: result.editedValue } }
          : proposal;
      await harness.skillEditor.apply(editedProposal);
    }
  }
}
