import {
  isRetryableAssistantError,
  type AssistantMessage,
  type AssistantMessageEvent,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { AssistantMessageEventStream } from '../pi-mono/ai/utils/event-stream.js';
import { createLogger } from '../app/logger.js';

const logger = createLogger();

export interface RetryingStreamOptions {
  /** Maximum retry attempts for transient provider/transport errors (0 disables). */
  maxRetries?: number;
  /** Base backoff delay in ms; per-attempt delay is baseDelayMs * 2^(attempt-1). */
  baseDelayMs?: number;
}

function createAbortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    const timer = setTimeout(
      () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function createErrorMessage(
  model: Parameters<StreamFn>[0],
  errorMessage: string,
  partial?: AssistantMessage,
): AssistantMessage {
  return {
    role: 'assistant',
    content: partial?.content ?? [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: partial?.usage ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    errorMessage,
    timestamp: Date.now(),
  };
}

/**
 * Wraps a provider stream function (e.g. pi-mono's `streamSimple`) with
 * bounded retry on transient provider/transport failures — including
 * mid-stream disconnects, which surface as `error` terminal events.
 *
 * Lives in OhMyAgent code (NOT inside `src/pi-mono`) so upgrades of the
 * embedded pi-mono stay patch-free. Retry behavior:
 * - Retryable = provider error classified by pi's `isRetryableAssistantError`
 *   (network errors, 408/409/429/5xx, premature stream end). Quota/billing
 *   exhaustion is never retried.
 * - Aborts (user /stop or SSE disconnect) are terminal and never retried.
 * - The `start` event is emitted once per logical response; retried attempts
 *   re-emit it internally and the wrapper drops the duplicates. Partial
 *   deltas already forwarded before a disconnect may briefly appear twice in
 *   live UI streams; the final AssistantMessage is always coherent.
 */
export function createRetryingStreamFn(
  base: StreamFn,
  options: RetryingStreamOptions = {},
): StreamFn {
  const maxRetries = options.maxRetries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 2000;

  return (model, context, streamOptions) => {
    const out = new AssistantMessageEventStream();

    /** Terminal-error exit. Converts abort-class failures (user /stop, SSE
     *  disconnect) into a graceful 'aborted' stop so the event bridge and UI
     *  treat them as a normal abort instead of a provider error bubble
     *  ("任务中断：模型调用失败…"). */
    const finishWithError = (
      event: AssistantMessageEvent | undefined,
      err: AssistantMessage,
    ): void => {
      const aborted =
        streamOptions?.signal?.aborted === true ||
        /^aborted$/i.test(err.errorMessage ?? '') ||
        /^request aborted$/i.test(err.errorMessage ?? '');
      if (aborted) {
        const graceful: AssistantMessage = {
          ...err,
          stopReason: 'aborted',
          errorMessage: undefined,
        };
        out.push({ type: 'error', reason: 'aborted', error: graceful });
        out.end(graceful);
        return;
      }
      out.push(event ?? { type: 'error', reason: 'error', error: err });
      out.end(err);
    };

    void (async () => {
      let attempt = 0;
      // Only the first attempt's start event may be forwarded — the agent
      // loop uses it to create the partial message. Retried attempts
      // re-emit it internally and the wrapper drops the duplicates.
      let forwardedStart = false;
      for (;;) {
        let baseStream: ReturnType<StreamFn>;
        try {
          baseStream = base(model, context, streamOptions);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const err = createErrorMessage(model, message);
          finishWithError(undefined, err);
          return;
        }

        let lastPartial: AssistantMessage | undefined;
        let terminalEvent: AssistantMessageEvent | undefined;
        let terminal: AssistantMessage | undefined;

        try {
          for await (const event of await baseStream) {
            if (event.type === 'start') {
              // Only the first attempt's start event may be forwarded —
              // the agent loop uses it to create the partial message.
              if (forwardedStart) continue;
              forwardedStart = true;
              out.push(event);
              continue;
            }
            if (event.type === 'done' || event.type === 'error') {
              terminalEvent = event;
              terminal = event.type === 'done' ? event.message : event.error;
              break;
            }
            if (event.partial) lastPartial = event.partial;
            out.push(event);
          }
        } catch (error) {
          // Iteration itself threw (e.g. the provider SDK's async iterator
          // surfacing a network reset). Without this catch the rejection
          // would escape the IIFE as an unhandled rejection (crashing the
          // process on Node ≥20) while `out` never ends — hanging the
          // agent loop forever. Synthesize a terminal error so the normal
          // retry/terminate logic below applies.
          const message = error instanceof Error ? error.message : String(error);
          const err = createErrorMessage(model, message, lastPartial);
          terminalEvent = { type: 'error', reason: 'error', error: err };
          terminal = err;
        }

        // Success — forward the terminal event as-is.
        if (terminalEvent?.type === 'done') {
          out.push(terminalEvent);
          out.end(terminal);
          return;
        }

        // Stream ended without a terminal event — treat as a transient
        // error (connection dropped before the SDK signaled completion).
        if (!terminal) {
          const err = createErrorMessage(
            model,
            'Provider stream ended without a terminal event',
            lastPartial,
          );
          if (attempt >= maxRetries) {
            logger.error(
              {
                provider: model.provider,
                model: model.id,
                maxRetries,
                errorMessage: err.errorMessage,
              },
              `Model ${model.provider}/${model.id} stream failed: ended without terminal event after ${maxRetries} retries`,
            );
            finishWithError(undefined, err);
            return;
          }
          terminal = err;
        }

        // Terminal error — retry only transient failures.
        if (attempt >= maxRetries || !isRetryableAssistantError(terminal)) {
          logger.error(
            {
              provider: model.provider,
              model: model.id,
              attempt,
              maxRetries,
              retryable: isRetryableAssistantError(terminal),
              errorMessage: terminal.errorMessage,
            },
            `Model ${model.provider}/${model.id} stream failed: ${isRetryableAssistantError(terminal) ? `retries exhausted (${maxRetries})` : 'non-retryable error'}`,
          );
          finishWithError(terminalEvent, terminal);
          return;
        }

        const retryDelayMs = baseDelayMs * 2 ** attempt;
        logger.warn(
          {
            provider: model.provider,
            model: model.id,
            retry: attempt + 1,
            maxRetries,
            delayMs: retryDelayMs,
            errorMessage: terminal.errorMessage,
          },
          `Retrying model ${model.provider}/${model.id} after transient error (retry ${attempt + 1}/${maxRetries}, backoff ${retryDelayMs}ms)`,
        );

        // Notify the host before the silent backoff window — the callback
        // feeds the agent's inactivity watchdog and can surface retry status
        // to users. Never let a callback error break the retry loop.
        if (streamOptions?.onStreamRetry) {
          try {
            await streamOptions.onStreamRetry({
              provider: model.provider,
              model: model.id,
              attempt: attempt + 1,
              maxRetries,
              delayMs: retryDelayMs,
              errorMessage: terminal.errorMessage,
            });
          } catch {
            /* best-effort */
          }
        }

        attempt++;
        try {
          await abortableSleep(retryDelayMs, streamOptions?.signal);
        } catch {
          // Aborted during backoff — report the original error.
          finishWithError(terminalEvent, terminal);
          return;
        }
      }
    })();

    return out;
  };
}
