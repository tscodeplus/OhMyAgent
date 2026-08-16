import {
	isRetryableAssistantError,
	type AssistantMessage,
	type AssistantMessageEvent,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { AssistantMessageEventStream } from '../pi-mono/ai/utils/event-stream.js';

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
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, Math.max(0, ms));
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
					out.push({ type: 'error', reason: 'error', error: err });
					out.end(err);
					return;
				}

				let lastPartial: AssistantMessage | undefined;
				let terminalEvent: AssistantMessageEvent | undefined;
				let terminal: AssistantMessage | undefined;

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

				// Success — forward the terminal event as-is.
				if (terminalEvent?.type === 'done') {
					out.push(terminalEvent);
					out.end(terminal);
					return;
				}

				// Stream ended without a terminal event — treat as a transient
				// error (connection dropped before the SDK signaled completion).
				if (!terminal) {
					const err = createErrorMessage(model, 'Provider stream ended without a terminal event', lastPartial);
					if (attempt >= maxRetries) {
						out.push({ type: 'error', reason: 'error', error: err });
						out.end(err);
						return;
					}
					terminal = err;
				}

				// Terminal error — retry only transient failures.
				if (attempt >= maxRetries || !isRetryableAssistantError(terminal)) {
					out.push(terminalEvent ?? { type: 'error', reason: 'error', error: terminal });
					out.end(terminal);
					return;
				}

				attempt++;
				try {
					await abortableSleep(baseDelayMs * 2 ** (attempt - 1), streamOptions?.signal);
				} catch {
					// Aborted during backoff — report the original error.
					out.push(terminalEvent ?? { type: 'error', reason: 'error', error: terminal });
					out.end(terminal);
					return;
				}
			}
		})();

		return out;
	};
}
