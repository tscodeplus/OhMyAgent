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
import { extractText, extractUserText } from '../shared/text-extract.js';
import { EventBridge } from './event-bridge.js';
import type { AgentEvent } from '../pi-mono/agent/types.js';
import type { ImageContent } from '../pi-mono/ai/types.js';
import { isContextOverflow } from '@earendil-works/pi-ai';
import { compressContext, estimateTokens } from './compress.js';
import { truncate } from '../shared/truncation.js';
import type { VisionBridgeService } from '../vision-bridge/vision-bridge-service.js';

export interface AgentServiceOptions {
  sessionId?: string;
  chatId?: string;
  messageId?: string;
  systemPrompt?: string;
  tools?: any[];
  historyMessages?: Array<{ role: string; content: string; timestamp: number }>;
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
  logger: Logger;
}

export class AgentService {
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
      const turnContext: AgentTurnContext = {};
      runtime = {
        agent: this.factory.create({
          ...options,
          message: input,
          agentId: agentIdFromSession ?? options?.agentId,
          turnContext,
        }),
        bridge: null,
        persistedMessageCount: options?.historyMessages?.length ?? 0,
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
    // Clear cached approval session so each turn gets a fresh tracker
    (runtime.turnContext as Record<string, unknown>).approvalSession = undefined;
    runtime.bridge = new EventBridge(dispatcher);
    runtime.bridge.start(runtime.agent);

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
              const result = await vb.bridge(finalInput, finalImages, model as any, { forceBridge: true });
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
                const result = await vb.bridge(finalInput, finalImages, model as any, { forceBridge: true });
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
    runtime.bridge = new EventBridge(dispatcher);
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
    runtime.bridge = new EventBridge(dispatcher);
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

    try {
      this.ensureSession(sessionKey);

      const agentState = agent.state as {
        messages?: Array<{
          role: string;
          content: string | Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: Record<string, unknown> }>;
          usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
          model?: string;
          timestamp?: number;
        }>;
      };
      const messages = agentState.messages ?? [];
      const startIndex = runtime.persistedMessageCount > messages.length
        ? 0
        : runtime.persistedMessageCount;
      // Get the full batch slice (includes toolResult messages)
      const batchMessages = messages.slice(startIndex);
      // Filter to user/assistant for persistence
      const newMessages = batchMessages.filter(
        (msg) => msg.role === 'user' || msg.role === 'assistant',
      );

      // Pre-scan: extract images/files from toolResult messages in this batch.
      // Only scan the CURRENT batch to avoid re-extracting old results.
      const batchImages: Array<{ url: string; alt?: string }> = [];
      const batchFiles: Array<{ name: string; path: string }> = [];
      const seenUrls = new Set<string>();
      for (const m of batchMessages) {
        if (m.role !== 'toolResult' || !Array.isArray(m.content)) continue;
        const text = m.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text || '')
          .join('\n');
        // Extract markdown image URLs
        const imgRegex = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
        let imgMatch: RegExpExecArray | null;
        while ((imgMatch = imgRegex.exec(text)) !== null) {
          const url = imgMatch[2];
          if (!seenUrls.has(url)) {
            seenUrls.add(url);
            batchImages.push({ alt: imgMatch[1] || undefined, url });
          }
        }
        // Extract file download links: [name](url) — only serve/download links
        const linkRegex = /\[([^\]]+)\]\((\/[^)]+)\)/g;
        let lm: RegExpExecArray | null;
        while ((lm = linkRegex.exec(text)) !== null) {
          const linkUrl = lm[2];
          if (linkUrl.startsWith('/api/files/serve') || linkUrl.startsWith('/api/files/download')) {
            if (!seenUrls.has(linkUrl)) {
              seenUrls.add(linkUrl);
              batchFiles.push({ name: lm[1], path: linkUrl });
            }
          }
        }
      }

      // Group consecutive assistant messages to preserve block-level
      // ordering of text and tool calls. This lets the API reconstruct
      // segments for interleaved rendering instead of showing all tool
      // cards at the bottom after a page refresh.
      interface PendingAssistant {
        blocks: Array<{ type: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> }>;
        usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
        model?: string;
        provider?: string;
      }

      let pendingAssistant: PendingAssistant | null = null;

      const flushPendingAssistant = (isFinal: boolean) => {
        const pending = pendingAssistant!;
        if (!pending || pending.blocks.length === 0) return;

        // 1. Join text blocks → flat content string (backward compat)
        const textParts: string[] = [];
        for (const block of pending.blocks) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          }
        }
        let content = textParts.join('\n');

        // Strip image markdown that's already in batchImages (prevents
        // double rendering: once from meta.images thumbnail + once from
        // ReactMarkdown in the message body).
        if (batchImages.length > 0) {
          for (const img of batchImages) {
            const escaped = img.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            content = content.replace(new RegExp(`!\\[[^\\]]*\\]\\(${escaped}\\)`, 'g'), '');
          }
          content = content.trim();
        }

        // 2. Extract tool calls from blocks (deduplicated by id)
        const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
        const toolCallIds = new Set<string>();
        for (const block of pending.blocks) {
          if (block.type === 'toolCall' && block.id && block.name && !toolCallIds.has(block.id)) {
            toolCallIds.add(block.id);
            toolCalls.push({
              id: block.id,
              name: block.name,
              arguments: (block.arguments || {}) as Record<string, unknown>,
            });
          }
        }

        // Skip empty messages with no tool calls
        if (!content.trim() && toolCalls.length === 0) return;

        // 3. Build segments from block order when tool calls are present.
        // Only store segments when there are tool calls — text-only
        // messages don't need the overhead (legacy rendering is identical).
        let segments: Array<{ type: 'text'; content: string } | { type: 'tool_call'; id: string }> | undefined;
        if (toolCalls.length > 0) {
          segments = [];
          for (const block of pending.blocks) {
            if (block.type === 'text' && block.text) {
              segments.push({ type: 'text', content: block.text });
            } else if (block.type === 'toolCall' && block.id) {
              segments.push({ type: 'tool_call', id: block.id });
            }
          }
        }

        // 4. Build metadata
        const meta: Record<string, unknown> = {};
        if (segments) {
          meta.segments = segments;
        }
        if (toolCalls.length > 0) {
          meta.tool_calls = toolCalls;
        }
        // Attach images/files only to the final assistant flush in the batch
        if (isFinal) {
          if (batchImages.length > 0) meta.images = batchImages;
          if (batchFiles.length > 0) meta.files = batchFiles;
        }
        if (pending.usage) {
          meta.usage = {
            input: pending.usage.input ?? 0,
            output: pending.usage.output ?? 0,
            cacheRead: pending.usage.cacheRead ?? 0,
            cacheWrite: pending.usage.cacheWrite ?? 0,
          };
        }
        if (pending.model) {
          meta.model = pending.provider
            ? (pending.model.startsWith(`${pending.provider}/`) ? pending.model : `${pending.provider}/${pending.model}`)
            : pending.model;
        }
        const agentName = (agent as any).ohmyagent_agentName || runtime.agentName;
        if (agentName) meta.agentName = agentName;
        if (runtime.turnElapsed) meta.elapsed = runtime.turnElapsed;
        // Store footer config snapshot so historical messages retain their
        // display settings even after the global config changes.
        if (runtime.footerConfig) meta.footerConfig = runtime.footerConfig;

        const metadata = Object.keys(meta).length > 0 ? JSON.stringify(meta) : null;

        messageRepository.create({
          id: generateId(),
          session_id: sessionKey,
          role: 'assistant',
          content,
          metadata,
        });
      };

      for (let mi = 0; mi < newMessages.length; mi++) {
        const msg = newMessages[mi];

        if (msg.role === 'user') {
          // Flush any pending assistant group before the user message
          if (pendingAssistant !== null) {
            flushPendingAssistant(false);
            pendingAssistant = null;
          }

          const content = extractUserText(msg.content);
          if (content.trim()) {
            messageRepository.create({
              id: generateId(),
              session_id: sessionKey,
              role: 'user',
              content,
              metadata: null,
              created_at: msg.timestamp,
            });
          }
          continue;
        }

        // Assistant message — accumulate into pending group only when tool
        // calls are involved (to preserve block ordering for interleaved
        // rendering). Text-only assistants without tool calls are persisted
        // immediately for backward compatibility.
        if (msg.role === 'assistant') {
          const hasToolCalls = Array.isArray(msg.content) &&
            msg.content.some((block: any) => block.type === 'toolCall');
          const pendingHasToolCalls = pendingAssistant !== null &&
            pendingAssistant.blocks.some(b => b.type === 'toolCall');

          // Persist immediately when no tool calls are involved — this is
          // the common case (simple text reply) and keeps the old behavior.
          if (!hasToolCalls && !pendingHasToolCalls) {
            // Flush any pending non-tool-call group first (shouldn't exist)
            if (pendingAssistant !== null) {
              flushPendingAssistant(false);
              pendingAssistant = null;
            }

            let content = extractText(msg.content);
            // Strip image markdown already in batchImages (avoid double display)
            if (batchImages.length > 0) {
              for (const img of batchImages) {
                const escaped = img.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                content = content.replace(new RegExp(`!\\[[^\\]]*\\]\\(${escaped}\\)`, 'g'), '');
              }
              content = content.trim();
            }
            if (content.trim()) {
              const meta: Record<string, unknown> = {};
              if (msg.usage) {
                meta.usage = {
                  input: msg.usage.input ?? 0,
                  output: msg.usage.output ?? 0,
                  cacheRead: msg.usage.cacheRead ?? 0,
                  cacheWrite: msg.usage.cacheWrite ?? 0,
                };
              }
              if (msg.model) {
                const prov = (msg as any).provider as string | undefined;
                meta.model = prov
                  ? (msg.model.startsWith(`${prov}/`) ? msg.model : `${prov}/${msg.model}`)
                  : msg.model;
              }
              const agentName = (agent as any).ohmyagent_agentName || runtime.agentName;
              if (agentName) meta.agentName = agentName;
              if (runtime.turnElapsed) meta.elapsed = runtime.turnElapsed;
              if (runtime.footerConfig) meta.footerConfig = runtime.footerConfig;
              // Only attach images/files to the last assistant.
              // Since this is a simple text-only msg in isolation,
              // determine if it's the last assistant in the batch.
              const lastAssistantIndex = newMessages.reduce(
                (last, m, i) => m.role === 'assistant' ? i : last, -1,
              );
              if (mi === lastAssistantIndex) {
                if (batchImages.length > 0) meta.images = batchImages;
                if (batchFiles.length > 0) meta.files = batchFiles;
              }
              const metadata = Object.keys(meta).length > 0 ? JSON.stringify(meta) : null;

              messageRepository.create({
                id: generateId(),
                session_id: sessionKey,
                role: 'assistant',
                content,
                metadata,
              });
            }
            continue;
          }

          // Tool calls involved — accumulate into pending group to preserve
          // block ordering across consecutive assistant messages.
          if (pendingAssistant === null) {
            pendingAssistant = { blocks: [] };
          }

          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              // Skip thinking blocks — suppressed in all channels
              if (block.type !== 'thinking') {
                pendingAssistant.blocks.push(block);
              }
            }
          } else if (typeof msg.content === 'string' && msg.content.trim()) {
            // String content (no tool calls) — treat as single text block
            pendingAssistant.blocks.push({ type: 'text', text: msg.content });
          }

          // Track usage/model from the latest assistant msg in the group
          if (msg.usage) pendingAssistant.usage = msg.usage;
          if (msg.model) pendingAssistant.model = msg.model;
          if ((msg as any).provider) pendingAssistant.provider = (msg as any).provider;
        }
      }

      // Flush final pending assistant group with images/files attached
      if (pendingAssistant !== null) {
        flushPendingAssistant(true);
        pendingAssistant = null;
      }

      runtime.persistedMessageCount = messages.length;

      logger.info({ sessionKey, messageCount: newMessages.length }, 'Messages persisted');
    } catch (err) {
      logger.warn({ err, sessionKey }, 'Failed to persist messages');
    }
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
  private async _recoverFromOverflow(
    agent: Agent,
    runtime: NonNullable<ReturnType<typeof this.runtimes.get>>,
    sessionId?: string,
  ): Promise<void> {
    if (!sessionId) return;

    const compressCfg = this.factory.getAutoCompressConfig?.();
    if (!compressCfg) return;

    const messages = agent.state.messages;
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== 'assistant') return;

    const assistantMsg = lastMsg as any;
    if (!isContextOverflow(assistantMsg, compressCfg.contextWindow)) return;

    this.persistence?.logger.info({ sessionId }, 'Context overflow detected, compacting and retrying');

    // Remove the overflow error message from state
    agent.state.messages = messages.slice(0, -1);

    // Compress context
    try {
      const result = await compressContext({
        messages: agent.state.messages as any,
        contextWindow: compressCfg.contextWindow,
        settings: { reserveTokens: 16384, keepRecentTokens: 20000 },
        sessionKey: sessionId,
        mainModelRef: compressCfg.mainModelRef,
        globalFallbackRefs: compressCfg.globalFallbackRefs,
        compressModelRef: compressCfg.compressModelRef,
        compressFallbackRefs: compressCfg.compressFallbackRefs,
        apiKeys: compressCfg.apiKeys,
        baseUrls: compressCfg.baseUrls,
        baseUrl: compressCfg.baseUrl,
        logger: this.persistence?.logger,
      });

      if (result.summaryMessage && result.compressedIndex > 0) {
        const recentMessages = agent.state.messages.slice(result.compressedIndex);
        agent.state.messages = [result.summaryMessage as any, ...recentMessages];
        this.persistence?.logger.info({
          sessionId,
          compressedCount: result.compressedIndex,
          keptCount: recentMessages.length,
        }, 'Context compacted after overflow, retrying');
      }
    } catch (err) {
      this.persistence?.logger.warn({ sessionId, err }, 'Overflow compaction failed, continuing without retry');
      return;
    }

    // Retry the turn with compacted context
    try {
      await agent.continue();
      // Re-persist messages after retry
      if (this.persistence && sessionId) {
        await this.persistMessages(agent, sessionId, runtime);
      }
    } catch (err) {
      this.persistence?.logger.warn({ sessionId, err }, 'Overflow retry failed');
    }
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
    const startedAt = new Map<string, number>();
    const toolNames = new Map<string, string>();

    return agent.subscribe((event: AgentEvent) => {
      if (event.type === 'tool_execution_start') {
        startedAt.set(event.toolCallId, Date.now());
        toolNames.set(event.toolCallId, event.toolName);
        const runId = `${sessionId}:${event.toolCallId}`;
        toolRunRepository.create({
          id: runId,
          session_id: sessionId,
          tool_name: event.toolName,
          input: summarizeToolArgs(event.args),
          status: 'started',
          metadata: JSON.stringify({ toolCallId: event.toolCallId }),
        });
        return;
      }

      if (event.type === 'tool_execution_end') {
        const started = startedAt.get(event.toolCallId);
        const durationMs = started ? Date.now() - started : null;
        const runId = `${sessionId}:${event.toolCallId}`;
        toolRunRepository.update(runId, {
          output: summarizeToolResult(event.result),
          status: event.isError ? 'error' : 'success',
          duration_ms: durationMs,
          error: event.isError ? summarizeToolResult(event.result) : null,
          metadata: JSON.stringify({
            toolCallId: event.toolCallId,
            toolName: toolNames.get(event.toolCallId) ?? event.toolName,
            isError: event.isError,
          }),
        });
        startedAt.delete(event.toolCallId);
        toolNames.delete(event.toolCallId);
      }
    });
  }
}

function summarizeToolArgs(args: unknown): string {
  if (!args || typeof args !== 'object') {
    return truncate(String(args ?? ''), 240);
  }

  if ('command' in (args as Record<string, unknown>) && typeof (args as Record<string, unknown>).command === 'string') {
    return truncate((args as Record<string, unknown>).command as string, 240);
  }

  return truncate(JSON.stringify(args), 240);
}

function summarizeToolResult(result: unknown): string {
  const text = extractText((result as { content?: unknown } | null)?.content ?? result);
  return truncate(text, 500);
}
