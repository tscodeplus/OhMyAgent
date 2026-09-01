import { describe, it, expect, vi } from 'vitest';
import {
	AssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEvent,
} from '@earendil-works/pi-ai';
import { createRetryingStreamFn } from '../../src/agent/retrying-stream.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: 'assistant',
		content: [],
		api: 'openai-completions',
		provider: 'test',
		model: 'test-model',
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: 'stop',
		timestamp: Date.now(),
		...overrides,
	};
}

function makeStream(events: AssistantMessageEvent[]): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	for (const event of events) stream.push(event);
	const last = events[events.length - 1]!;
	stream.end(last.type === 'done' ? last.message : last.error);
	return stream;
}

const model = { id: 'test-model', provider: 'test', api: 'openai-completions' } as any;
const context = { systemPrompt: '', messages: [], tools: [] } as any;

function startEvent(): AssistantMessageEvent {
	return { type: 'start', partial: makeMessage() };
}

function deltaEvent(text: string): AssistantMessageEvent {
	return {
		type: 'text_delta',
		contentIndex: 0,
		delta: text,
		partial: makeMessage({ content: [{ type: 'text', text }] }),
	};
}

function doneEvent(): AssistantMessageEvent {
	return { type: 'done', reason: 'stop', message: makeMessage({ content: [{ type: 'text', text: 'ok' }] }) };
}

function errorEvent(errorMessage: string): AssistantMessageEvent {
	return {
		type: 'error',
		reason: 'error',
		error: makeMessage({ stopReason: 'error', errorMessage, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }),
	};
}

async function collect(wrapped: ReturnType<ReturnType<typeof createRetryingStreamFn>>) {
	const events: AssistantMessageEvent[] = [];
	for await (const event of wrapped) events.push(event);
	return { events, result: await wrapped.result() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createRetryingStreamFn', () => {
	it('passes successful streams through unchanged', async () => {
		const base = vi.fn().mockReturnValue(makeStream([startEvent(), deltaEvent('hi'), doneEvent()]));
		const wrapped = createRetryingStreamFn(base, { maxRetries: 2, baseDelayMs: 1 })(model, context, {});

		const { events, result } = await collect(wrapped);

		expect(base).toHaveBeenCalledTimes(1);
		expect(events.map((e) => e.type)).toEqual(['start', 'text_delta', 'done']);
		expect(result.stopReason).toBe('stop');
	});

	it('retries a transient mid-stream error and succeeds on the second attempt', async () => {
		const base = vi.fn()
			.mockReturnValueOnce(makeStream([startEvent(), deltaEvent('partial '), errorEvent('fetch failed')]))
			.mockReturnValueOnce(makeStream([startEvent(), deltaEvent('full'), doneEvent()]));
		const wrapped = createRetryingStreamFn(base, { maxRetries: 2, baseDelayMs: 1 })(model, context, {});

		const { events, result } = await collect(wrapped);

		expect(base).toHaveBeenCalledTimes(2);
		// 'start' is forwarded once; retried attempt re-emits it internally but
		// the wrapper drops the duplicate. Partial deltas may repeat.
		expect(events.filter((e) => e.type === 'start')).toHaveLength(1);
		expect(events.filter((e) => e.type === 'text_delta').map((e) => (e as any).delta)).toEqual(['partial ', 'full']);
		expect(events.at(-1)?.type).toBe('done');
		expect(result.stopReason).toBe('stop');
	});

	it('does not retry non-transient errors (quota/billing)', async () => {
		const base = vi.fn().mockReturnValue(makeStream([startEvent(), errorEvent('insufficient_quota')]));
		const wrapped = createRetryingStreamFn(base, { maxRetries: 3, baseDelayMs: 1 })(model, context, {});

		const { events, result } = await collect(wrapped);

		expect(base).toHaveBeenCalledTimes(1);
		expect(events.at(-1)?.type).toBe('error');
		expect(result.stopReason).toBe('error');
		expect(result.errorMessage).toContain('insufficient_quota');
	});

	it('gives up after exhausting retries and surfaces the last error', async () => {
		const errorStream = () => makeStream([startEvent(), errorEvent('connection refused')]);
		const base = vi.fn()
			.mockReturnValueOnce(errorStream())
			.mockReturnValueOnce(errorStream())
			.mockReturnValueOnce(errorStream());
		const wrapped = createRetryingStreamFn(base, { maxRetries: 2, baseDelayMs: 1 })(model, context, {});

		const { events, result } = await collect(wrapped);

		expect(base).toHaveBeenCalledTimes(3); // initial + 2 retries
		expect(events.at(-1)?.type).toBe('error');
		expect(result.stopReason).toBe('error');
		expect(result.errorMessage).toContain('connection refused');
	});

	it('does not retry aborted streams', async () => {
		const base = vi.fn().mockReturnValue(makeStream([startEvent(), errorEvent('Request was aborted')]));
		const wrapped = createRetryingStreamFn(base, { maxRetries: 2, baseDelayMs: 1 })(model, context, {});

		const { result } = await collect(wrapped);

		expect(base).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe('error');
	});

	it('invokes onStreamRetry before each retry backoff and forwards attempt counters', async () => {
		const errorStream = () => makeStream([startEvent(), errorEvent('503 service unavailable')]);
		const base = vi.fn().mockReturnValue(errorStream());
		const onStreamRetry = vi.fn().mockResolvedValue(undefined);
		const wrapped = createRetryingStreamFn(base, { maxRetries: 2, baseDelayMs: 1 })(
			model,
			context,
			{ onStreamRetry } as any,
		);

		const { events, result } = await collect(wrapped);

		expect(base).toHaveBeenCalledTimes(3); // initial + 2 retries
		expect(result.stopReason).toBe('error');
		// One callback per retry (not per attempt), with 1-based attempt numbers.
		expect(onStreamRetry).toHaveBeenCalledTimes(2);
		expect(onStreamRetry).toHaveBeenNthCalledWith(1, {
			provider: model.provider,
			model: model.id,
			attempt: 1,
			maxRetries: 2,
			delayMs: 1,
			errorMessage: '503 service unavailable',
		});
		expect(onStreamRetry).toHaveBeenNthCalledWith(2, expect.objectContaining({ attempt: 2 }));
		// The callback must not leak any events into the stream — consumers only
		// see the protocol events (start forwarded once + terminal error).
		expect(events.filter((e) => e.type === 'start')).toHaveLength(1);
		expect(events.at(-1)?.type).toBe('error');
	});

	it('does not invoke onStreamRetry for non-retryable failures', async () => {
		const base = vi.fn().mockReturnValue(makeStream([startEvent(), errorEvent('insufficient_quota')]));
		const onStreamRetry = vi.fn().mockResolvedValue(undefined);
		const wrapped = createRetryingStreamFn(base, { maxRetries: 2, baseDelayMs: 1 })(
			model,
			context,
			{ onStreamRetry } as any,
		);

		await collect(wrapped);

		expect(base).toHaveBeenCalledTimes(1);
		expect(onStreamRetry).not.toHaveBeenCalled();
	});
});
