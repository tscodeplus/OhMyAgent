/**
 * EventBridge — translates pi-mono Agent lifecycle events into
 * ReplyDispatcher callbacks for Feishu card streaming.
 */

import type { Agent } from '../pi-mono/agent/agent.js';
import type { AgentEvent } from '../pi-mono/agent/types.js';
import type { ReplyDispatcher, Usage } from '../app/types.js';
import type { Logger } from 'pino';
import { computeCacheHitRate } from '../channel/usage-summary.js';

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
  private agent?: Agent;
  /** Called before onComplete/onError/onAborted to persist state. */
  private preCompleteCallback?: () => Promise<void>;
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
        result += fullDelta.slice(i);
        break;
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

      if (openIdx !== -1) {
        // openIdx < closeIdx and we're inside a think block → nested open
        this.thinkBuffer += fullDelta.slice(i, openIdx + 7);
        this.thinkDepth++;
        i = openIdx + 7;
        continue;
      }
    }

    // Buffer the tail in case a <think> / </think> tag is split across deltas
    const TAG_STARTS = ['<', '</', '<t', '</t', '<th', '</th', '<thi', '</thi', '<thin', '</thin', '<think', '</think'];
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
   * Every line between <plan> and </plan> (inclusive) gets a "> " prefix so
   * Feishu/WebUI render a continuous vertical bar alongside the entire plan
   * block — matching the visual style of tool call indicators.
   *
   *   > <plan>
   *   > ### 子任务分解
   *   > 1. 搜索相关文件
   *   > 2. 分析代码结构
   *   </plan>
   *
   * A blank line after </plan> separates the plan from subsequent content.
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
    // Open blockquote with the <plan> tag, then "> " for the first content line
    const OPEN_STYLED = '\n> <plan>\n> ';
    const CLOSE_STYLED = '\n</plan>\n\n';

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
        result += blockquoteLines(fullDelta.slice(i));
        break;
      }

      // Entering plan: add "> " before the tag and start content blockquote
      if (this.planDepth === 0 && openIdx !== -1 && (closeIdx === -1 || openIdx < closeIdx)) {
        result += fullDelta.slice(i, openIdx); // text before <plan>
        result += OPEN_STYLED;
        this.planDepth = 1;
        i = openIdx + OPEN_LEN;
        // Skip leading \n after <plan> to keep tag and first content line adjacent
        if (i < fullDelta.length && fullDelta[i] === '\n') {
          i++;
        }
        continue;
      }

      // Exiting plan: blockquote the content before </plan>, then close
      if (this.planDepth > 0 && closeIdx !== -1 && (openIdx === -1 || closeIdx < openIdx)) {
        result += blockquoteLines(fullDelta.slice(i, closeIdx));
        result += CLOSE_STYLED;
        this.planDepth = 0;
        i = closeIdx + CLOSE_LEN;
        continue;
      }

      // Nested <plan> inside plan body — keep as literal text with bar
      if (this.planDepth > 0 && openIdx !== -1) {
        result += blockquoteLines(fullDelta.slice(i, openIdx + OPEN_LEN));
        i = openIdx + OPEN_LEN;
        continue;
      }
    }

    // Buffer partial tag prefix in case it's split across deltas.
    // Check against fullDelta (pre-transformation) but strip from result
    // (post-transformation) — prefix length is the same either way because
    // the "\n> " transform only adds bytes before newlines, and tag
    // prefixes never contain newlines.
    const TAG_STARTS = ['<', '</', '<p', '</p', '<pl', '</pl', '<pla', '</pla', '<plan', '</pla'];
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
      } catch { this.logger?.debug('Dispatcher setModel failed — continuing'); }
    }

    this.unsubscribe = agent.subscribe(async (event: AgentEvent) => {
      switch (event.type) {
        case 'agent_start':
          this.resetPlanFilter(); // Prevent <plan> state leakage across turns
          await this.dispatchSafely(() => this.replyDispatcher.onStart());
          // Dispatch skill activation AFTER turn_start so the frontend has
          // already created the message bubble (beginTurn) before the
          // skill text_delta arrives. order: turn_start → skill text_delta.
          if (this.pendingSkillName) {
            await this.dispatchSafely(() => this.replyDispatcher.onSkillActivated?.(this.pendingSkillName!));
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

        case 'tool_execution_end':
          this.replyDispatcher.onToolEnd(event.toolName, event.result, event.isError, event.toolCallId);
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
            await this.dispatchSafely(() => this.replyDispatcher.onError(
              new Error(assistantMsg.errorMessage ?? 'Agent error'),
            ));
          } else if (assistantMsg && assistantMsg.stopReason === 'aborted') {
            await this.dispatchSafely(() => this.replyDispatcher.onAborted());
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
            await this.dispatchSafely(() => this.replyDispatcher.onComplete(usageOut));
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
}

function findLastAssistantMessage(
  messages: Array<{ role: string; stopReason?: string; errorMessage?: string; usage?: any; provider?: string; model?: string }>,
) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'assistant') {
      return messages[i] as { role: 'assistant'; stopReason: string; errorMessage?: string; usage: any; provider?: string; model?: string };
    }
  }
  return undefined;
}
