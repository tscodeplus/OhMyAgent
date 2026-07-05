/**
 * Agent Service
 *
 * High-level interface for executing agent prompts.
 * Keeps the Agent alive across turns so pi-mono's built-in
 * state.messages provides native conversation continuity.
 */

import type { AgentFactory } from './agent-factory.js';
import type { AgentTurnContext } from './agent-factory.js';
import type { Agent } from '../pi-mono/agent/agent.js';
import { setSessionAgent, clearSessionAgent } from './agent-context.js';
import type { ReplyDispatcher, FooterConfig } from '../app/types.js';
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
import { subscribeToolRunAudit } from './tool-audit.js';

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

export class AgentService {
  /** Sessions explicitly cleared by /new or /clear — skip history load on next message. */
  private clearedSessions = new Set<string>();

  private runtimes = new Map<string, {
    agent: Agent;
    bridge: EventBridge | null;
    auditUnsubscribe?: () => void;
    persistedMessageCount: number;
    turnElapsed?: number;
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

  constructor(
    private factory: AgentFactory,
    private replyDispatcherFactory: (chatId: string, messageId?: string, agentId?: string) => ReplyDispatcher,
    private persistence?: AgentServicePersistenceOptions,
    /** Lazy factory — VisionBridgeService is only created on first image analysis. */
    private getVisionBridge?: () => VisionBridgeService | undefined,
    private imageMode: 'native_first' | 'bridge_only' | 'native_only' = 'native_first',
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
      await agent.prompt(finalInput, finalImages);
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

      return agent;
    } catch (error) {
      runtime.bridge?.stop();
      runtime.auditUnsubscribe?.();
      this.runtimes.delete(sessionId);
      this.persistence?.logger.error({ err: error }, 'agent execute error');
      throw error;
    }
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
    if (sessionId) {
      const runtime = this.runtimes.get(sessionId);
      if (!runtime) return;
      runtime.agent.abort();
      // waitForIdle resolves after all agent_end listeners (including
      // the pre-complete persistMessages callback) have settled.
      await runtime.agent.waitForIdle().catch(() => {});
      return;
    }

    for (const runtime of this.runtimes.values()) {
      runtime.agent.abort();
    }
    // Wait for all runtimes to settle
    await Promise.allSettled(
      Array.from(this.runtimes.values()).map(r =>
        r.agent.waitForIdle().catch(() => {}),
      ),
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
      } catch { /* dispatcher may not support setModel */ }
    }

    // Finalize old card so generated content is preserved
    try {
      await runtime.turnContext.replyDispatcher?.onComplete();
    } catch { /* ignore — best-effort finalization */ }

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
    this.runOnIdleCard(runtime, message, replyToMessageId, agentId);
    return true;
  }

  private async runOnIdleCard(
    runtime: NonNullable<ReturnType<typeof this.runtimes.get>>,
    message: string,
    replyToMessageId?: string,
    agentId?: string,
  ): Promise<void> {
    try {
      await runtime.agent.waitForIdle();
    } catch {
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
    runtime.agent.prompt(message).catch(() => {});
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
}
