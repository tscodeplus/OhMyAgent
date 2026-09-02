/**
 * EventBridge — translates pi-mono Agent lifecycle events into
 * ReplyDispatcher callbacks for Feishu card streaming.
 */

import type { Agent } from '../pi-mono/agent/agent.js';
import type { AgentEvent } from '../pi-mono/agent/types.js';
import type { ReplyDispatcher, Usage } from '../app/types.js';
import type { Logger } from 'pino';
import { computeCacheHitRate } from '../channel/usage-summary.js';
import { i18n } from '../i18n/index.js';
import { buildFriendlyErrorMessage, qualifyModelRef } from './provider-error.js';

export class EventBridge {
  private unsubscribe?: () => void;
  /** Track nesting depth for <think> blocks across streaming deltas. */
  private thinkDepth = 0;
  private thinkBuffer = '';
  /** Buffer for partial <think> / </think> tags split across delta boundaries. */
  private thinkPartial = '';
  /** Track stripping state for <plan>...</plan> blocks (flat, no nesting). */
  private planDepth = 0;
  private planPartial = '';
  /** Incomplete last line inside a <plan> block, held back so tokens split
   *  across deltas are localized only after they are complete. */
  private planLineBuffer = '';
  private agent?: Agent;
  /** Called before onComplete/onError/onAborted to persist state. */
  private preCompleteCallback?: () => Promise<void>;
  /** Whether the current run has already dispatched its terminal signal.
   *  Re-armed on agent_start — see dispatchTerminal. */
  private terminalDispatched = false;
  private logger?: Logger;
  /**
   * Skill name to dispatch after the next agent_start event.
   * Set before agent.prompt() so that onSkillActivated fires
   * AFTER onStart (turn_start SSE), ensuring the frontend has
   * created a message bubble before the skill text_delta arrives.
   */
  pendingSkillName?: string;

  constructor(
    private replyDispatcher: ReplyDispatcher,
    logger?: Logger,
  ) {
    this.logger = logger;
  }

  /**
   * Register a callback that fires before the agent_end completion events
   * (onComplete / onError / onAborted). Use this to persist messages or
   * other state so that downstream consumers see it when they react to
   * the completion signal (e.g. a WebUI refetch on SSE "done").
   */
  setPreCompleteCallback(cb: () => Promise<void>): void {
    this.preCompleteCallback = cb;
  }

  /**
   * Strip <think>...</think> blocks from text delta.
   * Uses a nesting-depth counter to handle (unlikely but possible) nested
   * <think> tags emitted by the model.
   */
  private filterThinkDelta(delta: string): string {
    // Prepend any partial tag buffered from the previous delta
    const fullDelta = this.thinkPartial + delta;
    this.thinkPartial = '';

    let result = '';
    let i = 0;
    while (i < fullDelta.length) {
      const openIdx = fullDelta.indexOf('<think>', i);
      const closeIdx = fullDelta.indexOf('</think>', i);

      if (this.thinkDepth === 0 && openIdx === -1) {
        if (closeIdx === -1) {
          result += fullDelta.slice(i);
          break;
        }
        // No opener left in this slice but a closing tag: a stray. Emit the
        // text before it, drop the tag itself, and keep scanning.
        result += fullDelta.slice(i, closeIdx);
        i = closeIdx + 8;
        continue;
      }

      if (this.thinkDepth > 0 && closeIdx === -1) {
        this.thinkBuffer += fullDelta.slice(i);
        break;
      }

      if (this.thinkDepth === 0 && openIdx !== -1 && (closeIdx === -1 || openIdx < closeIdx)) {
        result += fullDelta.slice(i, openIdx);
        this.thinkDepth = 1;
        this.thinkBuffer = '';
        i = openIdx + 7;
        continue;
      }

      if (this.thinkDepth > 0 && closeIdx !== -1 && (openIdx === -1 || closeIdx < openIdx)) {
        this.thinkBuffer += fullDelta.slice(i, closeIdx);
        this.thinkDepth--;
        i = closeIdx + 8;
        continue;
      }

      if (this.thinkDepth > 0 && openIdx !== -1) {
        // openIdx < closeIdx and we're inside a think block → nested open
        this.thinkBuffer += fullDelta.slice(i, openIdx + 7);
        this.thinkDepth++;
        i = openIdx + 7;
        continue;
      }

      // depth === 0 with a close tag ahead of any open tag: a stray `</think>`
      // (model-emitted, or left over from a provider that already separated its
      // reasoning). The old code fell through to the nested-open branch here and
      // bumped depth to 1, which swallowed the ENTIRE remainder of the answer
      // into thinkBuffer — a card truncated mid-sentence. Strip the stray tag
      // and keep passing text through.
      if (this.thinkDepth === 0 && closeIdx !== -1) {
        result += fullDelta.slice(i, closeIdx);
        this.thinkPartial = ''; // the stray tag is consumed here, never shown
        i = closeIdx + 8;
        continue;
      }

      // Unreachable for well-formed input; pass the remainder through rather
      // than risk an infinite loop.
      result += fullDelta.slice(i);
      break;
    }

    // Buffer the tail in case a <think> / </think> tag is split across deltas
    const TAG_STARTS = [
      '<',
      '</',
      '<t',
      '</t',
      '<th',
      '</th',
      '<thi',
      '</thi',
      '<thin',
      '</thin',
      '<think',
      '</think',
    ];
    for (const prefix of TAG_STARTS) {
      if (fullDelta.endsWith(prefix) && fullDelta.length >= prefix.length) {
        result = result.slice(0, result.length - prefix.length);
        this.thinkPartial = prefix;
        break;
      }
    }

    return result;
  }

  /**
   * Style <plan>...</plan> blocks with a markdown blockquote bar.
   *
   * Replaces the <plan> tag with a 📋 header and blockquotes all content
   * lines — matching the WebUI's formatPlanBlocks behavior. The raw
   * <plan> and </plan> tags are stripped; only the inner content is shown
   * with a "> " prefix on every line.
   *
   *   > 📋 **Plan**
   *   >
   *   > ### 子任务分解
   *   > 1. 搜索相关文件
   *   > 2. 分析代码结构
   *
   * A blank line after the block separates the plan from subsequent content.
   */
  private filterPlanDelta(delta: string): string {
    const fullDelta = this.planPartial + delta;
    this.planPartial = '';

    let result = '';
    let i = 0;
    const OPEN = '<plan>';
    const CLOSE = '</plan>';
    const OPEN_LEN = 6;
    const CLOSE_LEN = 7;
    const planLabel = i18n.t('messages:plan.label');
    // Replace <plan> tag with a 📋 header, add a blank blockquote line for spacing
    const OPEN_STYLED = `\n> 📋 **${planLabel}**\n> \n> `;
    // Strip </plan> — just add blank line separation
    const CLOSE_STYLED = '\n\n';

    /** Prefix every newline with "> " so all lines inside plan get the bar. */
    const blockquoteLines = (s: string) => s.replace(/\n/g, '\n> ');

    while (i < fullDelta.length) {
      const openIdx = fullDelta.indexOf(OPEN, i);
      const closeIdx = fullDelta.indexOf(CLOSE, i);

      // No tags ahead and not inside plan → pass through
      if (this.planDepth === 0 && openIdx === -1) {
        result += fullDelta.slice(i);
        break;
      }

      // Inside plan, no close tag → prefix every line with "> "
      if (this.planDepth > 0 && closeIdx === -1) {
        // Only emit complete lines; hold back the trailing partial line so
        // headers/keywords split across deltas localize correctly.
        this.planLineBuffer += fullDelta.slice(i);
        const lastNewline = this.planLineBuffer.lastIndexOf('\n');
        if (lastNewline !== -1) {
          const complete = this.planLineBuffer.slice(0, lastNewline + 1);
          this.planLineBuffer = this.planLineBuffer.slice(lastNewline + 1);
          result += blockquoteLines(this.localizePlanContent(complete));
        }
        break;
      }

      // Entering plan: add header + blank blockquote line, then start content
      if (this.planDepth === 0 && openIdx !== -1 && (closeIdx === -1 || openIdx < closeIdx)) {
        result += fullDelta.slice(i, openIdx); // text before <plan>
        result += OPEN_STYLED;
        this.planDepth = 1;
        i = openIdx + OPEN_LEN;
        // Skip leading \n after <plan> so content starts on the "> " line
        if (i < fullDelta.length && fullDelta[i] === '\n') {
          i++;
        }
        continue;
      }

      // Exiting plan: blockquote the content before </plan>, then close
      if (this.planDepth > 0 && closeIdx !== -1 && (openIdx === -1 || closeIdx < openIdx)) {
        this.planLineBuffer += fullDelta.slice(i, closeIdx);
        result += blockquoteLines(this.localizePlanContent(this.planLineBuffer));
        this.planLineBuffer = '';
        result += CLOSE_STYLED;
        this.planDepth = 0;
        i = closeIdx + CLOSE_LEN;
        continue;
      }

      // Nested <plan> inside plan body — keep as literal text with bar
      if (this.planDepth > 0 && openIdx !== -1) {
        result += blockquoteLines(fullDelta.slice(i, openIdx + OPEN_LEN));
        i = openIdx + OPEN_LEN;
      }
    }

    // Buffer partial tag prefix in case it's split across deltas.
    // Check against fullDelta (pre-transformation) but strip from result
    // (post-transformation) — prefix length is the same either way because
    // the "\n> " transform only adds bytes before newlines, and tag
    // prefixes never contain newlines.
    const TAG_STARTS = ['<', '</', '<p', '</p', '<pl', '</pl', '<pla', '</pla', '<plan', '</plan'];
    for (const prefix of TAG_STARTS) {
      if (fullDelta.endsWith(prefix) && fullDelta.length >= prefix.length) {
        result = result.slice(0, result.length - prefix.length);
        this.planPartial = prefix;
        break;
      }
    }

    return result;
  }

  /** Reset plan filter state at turn boundaries to prevent leakage. */
  private resetPlanFilter(): void {
    this.planDepth = 0;
    this.planPartial = '';
    this.planLineBuffer = '';
  }

  /**
   * Reset think-block filter state at turn boundaries.
   *
   * Without this, a turn that ended while thinkDepth > 0 (aborted mid-block,
   * or an unbalanced tag from the model) would swallow the whole next turn's
   * text into thinkBuffer — the filter state is otherwise only cleared in
   * stop().
   */
  private resetThinkFilter(): void {
    this.thinkDepth = 0;
    this.thinkBuffer = '';
    this.thinkPartial = '';
  }

  /**
   * Localize well-known English plan-template strings emitted by the model.
   *
   * The team-mode prompt layer is English by design (model-facing), but the
   * <plan> block is rendered verbatim to the user — so its fixed section
   * headers and strategy keywords are mapped via i18n at display time.
   * Case-insensitive exact / word-boundary matching keeps this deterministic
   * while tolerating model casing drift; unknown wording passes through
   * untouched. For locales whose values equal the English originals (en),
   * replacements are no-ops.
   */
  private localizePlanContent(content: string): string {
    const tr = (key: string): string | null => {
      const v = i18n.t(key);
      return v && v !== key ? v : null;
    };
    const rules: Array<[RegExp, string]> = [];
    const h1 = tr('messages:plan.headers.subtaskDecomposition');
    if (h1) rules.push([/^### Subtask Decomposition.*$/im, `### ${h1}`]);
    const h2 = tr('messages:plan.headers.parallelStrategy');
    if (h2) rules.push([/^### Parallel Strategy.*$/im, `### ${h2}`]);
    const s1 = tr('messages:plan.strategies.allParallel');
    if (s1) rules.push([/\bAll-parallel\b/gi, s1]);
    const s2 = tr('messages:plan.strategies.sequential');
    if (s2) rules.push([/\bSequential\b/gi, s2]);
    const s3 = tr('messages:plan.strategies.mixed');
    if (s3) rules.push([/\bMixed\b/gi, s3]);
    let out = content;
    for (const [re, to] of rules) out = out.replace(re, to);
    return out;
  }

  /**
   * Subscribe to agent events and forward them to the reply dispatcher.
   *
   * Event mapping:
   *   agent_start        -> onStart()
   *   message_update / text_delta    -> onTextDelta(delta)
   *   message_update / thinking_delta -> onReasoningDelta(delta)
   *   tool_execution_start -> onToolStart(name, args)
   *   tool_execution_end   -> onToolEnd(name, result)
   *   agent_end           -> onComplete(usage) or onError(error)
   */
  start(agent: Agent): void {
    this.agent = agent;

    // Set the dispatcher's model from the agent's configured model immediately,
    // so the footer is correct from the start. The agent_end handler will still
    // update it later if a fallback model was actually used.
    const stateModel = (agent.state as any)?.model;
    if (stateModel?.provider && stateModel?.id) {
      const modelStr = `${stateModel.provider}/${stateModel.id}`;
      try {
        this.replyDispatcher.setModel(modelStr);
      } catch {
        this.logger?.debug('Dispatcher setModel failed — continuing');
      }
    }

    this.unsubscribe = agent.subscribe(async (event: AgentEvent) => {
      switch (event.type) {
        case 'agent_start':
          this.resetPlanFilter(); // Prevent <plan> state leakage across turns
          this.resetThinkFilter(); // ... and the same for unbalanced think tags
          this.terminalDispatched = false; // New run, new terminal signal allowed
          await this.dispatchSafely(() => this.replyDispatcher.onStart());
          // Dispatch skill activation AFTER turn_start so the frontend has
          // already created the message bubble (beginTurn) before the
          // skill text_delta arrives. order: turn_start → skill text_delta.
          if (this.pendingSkillName) {
            await this.dispatchSafely(() =>
              this.replyDispatcher.onSkillActivated?.(this.pendingSkillName!),
            );
            this.pendingSkillName = undefined;
          }
          break;

        case 'message_update': {
          const sub = event.assistantMessageEvent;
          if (sub.type === 'text_delta') {
            const filtered = this.filterPlanDelta(this.filterThinkDelta(sub.delta));
            if (filtered) {
              this.replyDispatcher.onTextDelta(filtered);
            }
          } else if (sub.type === 'thinking_delta') {
            this.replyDispatcher.onReasoningDelta(sub.delta);
          }
          break;
        }

        case 'tool_execution_start':
          this.replyDispatcher.onToolStart(event.toolName, event.args, event.toolCallId);
          break;

        case 'stream_retry':
          // Transient retry/fallback status — best-effort, channels without a
          // status surface simply ignore it. Raw errors stay in server logs;
          // only the failed model and progress counters are forwarded.
          try {
            this.replyDispatcher.onStreamRetry?.({
              scope: event.scope,
              failedModel: `${event.failedProvider}/${event.failedModel}`,
              model: `${event.provider}/${event.model}`,
              attempt: event.attempt,
              maxRetries: event.maxRetries,
              delayMs: event.delayMs,
            });
          } catch {
            /* best-effort */
          }
          break;

        case 'tool_execution_end':
          this.replyDispatcher.onToolEnd(
            event.toolName,
            event.result,
            event.isError,
            event.toolCallId,
          );
          break;

        case 'agent_end': {
          // Run pre-complete callback (e.g. persist messages) before
          // dispatching completion signals so that downstream consumers
          // see up-to-date state when they react.
          if (this.preCompleteCallback) {
            try {
              await this.preCompleteCallback();
            } catch (err) {
              this.logger?.debug({ err }, 'Pre-complete callback failed — continuing');
            }
          }

          // Find the last assistant message (may not be last if tools were called)
          const assistantMsg = findLastAssistantMessage(event.messages);

          // Update agent name for footer display (all channels)
          const agentName = this.agent?.ohmyagent_agentName;
          if (agentName) {
            this.replyDispatcher.setAgentName(agentName);
          }

          // Update footer model to reflect the actually-used model (including fallback)
          if (assistantMsg?.provider && assistantMsg?.model) {
            this.replyDispatcher.setModel(
              assistantMsg.model.startsWith(`${assistantMsg.provider}/`)
                ? assistantMsg.model
                : `${assistantMsg.provider}/${assistantMsg.model}`,
            );
          }

          if (assistantMsg && assistantMsg.stopReason === 'error') {
            this.logger?.warn(
              {
                err: new Error(assistantMsg.errorMessage ?? 'Agent error'),
                model: assistantMsg.model,
                provider: assistantMsg.provider,
              },
              'Agent turn failed with provider/stream error',
            );
            const friendlyMsg = buildFriendlyErrorMessage(
              assistantMsg.errorMessage ?? 'Agent error',
              qualifyModelRef(assistantMsg.provider, assistantMsg.model),
            );
            await this.dispatchTerminal(() => this.replyDispatcher.onError(new Error(friendlyMsg)));
          } else if (assistantMsg && assistantMsg.stopReason === 'aborted') {
            this.logger?.warn(
              { model: assistantMsg.model, provider: assistantMsg.provider },
              'Agent turn aborted',
            );
            await this.dispatchTerminal(() => this.replyDispatcher.onAborted());
          } else {
            const src = assistantMsg?.usage;
            const usageOut: Usage | undefined = src
              ? {
                  input: src.input,
                  output: src.output,
                  cacheRead: src.cacheRead,
                  cacheWrite: src.cacheWrite,
                  totalTokens: src.totalTokens,
                  cost: src.cost.total,
                  cacheHitRate: computeCacheHitRate(src),
                }
              : undefined;
            await this.dispatchTerminal(() => this.replyDispatcher.onComplete(usageOut));
          }
          break;
        }
      }
    });
  }

  /**
   * Unsubscribe from agent events.
   */
  stop(): void {
    this.thinkDepth = 0;
    this.thinkBuffer = '';
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private async dispatchSafely(operation: () => void | Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.logger?.warn({ err: error }, 'dispatchSafely: operation failed, routing to onError');
      try {
        await this.replyDispatcher.onError(
          error instanceof Error ? error : new Error(String(error)),
        );
      } catch (dispatchErr) {
        this.logger?.debug({ err: dispatchErr }, 'onError dispatch failed');
      }
    }
  }

  /**
   * Dispatch a turn-ending signal once per agent run.
   *
   * One run can end twice: the loop emits `agent_end` itself, and the agent's
   * catch-all failure handler emits another when something throws on the way
   * out. The card controller absorbs same-kind repeats, but error-then-success
   * slips past it and re-sends the answer as a stray text message.
   *
   * `agent_start` re-arms this, so the overflow-recovery retry — a second run
   * on this same subscription that follows a failed one — still delivers its
   * answer.
   */
  private async dispatchTerminal(operation: () => void | Promise<void>): Promise<void> {
    if (this.terminalDispatched) {
      this.logger?.debug('agent_end already dispatched terminally — skipping duplicate');
      return;
    }
    this.terminalDispatched = true;
    await this.dispatchSafely(operation);
  }
}

function findLastAssistantMessage(
  messages: Array<{
    role: string;
    stopReason?: string;
    errorMessage?: string;
    usage?: any;
    provider?: string;
    model?: string;
  }>,
) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'assistant') {
      return messages[i] as {
        role: 'assistant';
        stopReason: string;
        errorMessage?: string;
        usage: any;
        provider?: string;
        model?: string;
      };
    }
  }
  return undefined;
}
