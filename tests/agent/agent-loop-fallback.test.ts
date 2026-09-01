import { describe, it, expect, vi } from 'vitest';
import {
	AssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEvent,
} from '@earendil-works/pi-ai';
import { agentLoop } from '../../src/pi-mono/agent/agent-loop.js';
import type { AgentEvent, AgentLoopConfig } from '../../src/pi-mono/agent/types.js';
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

/** Terminal-event stream: start + one terminal event. */
function makeStream(events: AssistantMessageEvent[]): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	for (const event of events) stream.push(event);
	const last = events[events.length - 1]!;
	stream.end(last.type === 'done' ? last.message : last.error);
	return stream;
}

function okStream(model: AssistantMessage): AssistantMessageEventStream {
	const msg = { ...model, stopReason: 'stop' as const };
	return makeStream([
		{ type: 'start', partial: msg },
		{ type: 'done', reason: 'stop', message: msg },
	]);
}

function errorStream(model: AssistantMessage, errorMessage: string): AssistantMessageEventStream {
	const err = { ...model, stopReason: 'error' as const, errorMessage };
	return makeStream([
		{ type: 'start', partial: err },
		{ type: 'error', reason: 'error', error: err },
	]);
}

/** Fake Model whose id doubles as its AssistantMessage content marker. */
function fakeModel(provider: string, id: string) {
	return { provider, id, api: 'openai-completions' } as any;
}

function modelMessage(model: { provider: string; id: string }, overrides: Partial<AssistantMessage> = {}) {
	return makeMessage({ provider: model.provider, model: model.id, ...overrides });
}

function makeConfig(primary: any, fallbacks: any[]): AgentLoopConfig {
	return {
		model: primary,
		fallbackModels: fallbacks,
		convertToLlm: async (messages) => messages as any,
	};
}

/** Run agentLoop with a single user prompt and collect all emitted events. */
async function run(config: AgentLoopConfig, streamFn: any) {
	const events: AgentEvent[] = [];
	const stream = agentLoop(
		[{ role: 'user', content: 'hi', timestamp: Date.now() } as any],
		{ systemPrompt: '', messages: [], tools: [] } as any,
		config,
		undefined,
		streamFn,
	);
	for await (const event of stream) events.push(event);
	const messages = await stream.result();
	return { events, messages };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('agentLoop fallback stream_retry events', () => {
	it('emits a fallback stream_retry event per model switch and recovers on a later model', async () => {
		const m0 = fakeModel('prov0', 'model-0');
		const m1 = fakeModel('prov1', 'model-1');
		const m2 = fakeModel('prov2', 'model-2');

		const streamFn = vi.fn((model: any) => {
			if (model.id === 'model-0') return errorStream(modelMessage(model), 'boom 0');
			if (model.id === 'model-1') return errorStream(modelMessage(model), 'boom 1');
			return okStream(modelMessage(model));
		});

		const { events, messages } = await run(makeConfig(m0, [m1, m2]), streamFn);

		// One stream call per model in the chain.
		expect(streamFn).toHaveBeenCalledTimes(3);

		const retries = events.filter((e) => e.type === 'stream_retry') as Extract<
			AgentEvent,
			{ type: 'stream_retry' }
		>[];
		expect(retries).toHaveLength(2);

		// Switch 1: model-0 → model-1. `attempt` is the 1-based number of the
		// upcoming overall attempt; maxRetries counts the fallback budget.
		expect(retries[0]).toMatchObject({
			type: 'stream_retry',
			scope: 'fallback',
			failedProvider: 'prov0',
			failedModel: 'model-0',
			provider: 'prov1',
			model: 'model-1',
			attempt: 2,
			maxRetries: 2,
			delayMs: 0,
			errorMessage: 'boom 0',
		});
		expect(retries[1]).toMatchObject({
			type: 'stream_retry',
			scope: 'fallback',
			failedProvider: 'prov1',
			failedModel: 'model-1',
			provider: 'prov2',
			model: 'model-2',
			attempt: 3,
			maxRetries: 2,
			delayMs: 0,
			errorMessage: 'boom 1',
		});

		// Ordering: each fallback event follows the failed attempt's message_end.
		const lastIdxOf = (pred: (e: AgentEvent) => boolean, upTo: number) => {
			let idx = -1;
			events.forEach((e, i) => {
				if (i < upTo && pred(e)) idx = i;
			});
			return idx;
		};
		const firstRetryIdx = events.findIndex((e) => e.type === 'stream_retry');
		expect(lastIdxOf((e) => e.type === 'message_end', firstRetryIdx)).toBeGreaterThanOrEqual(0);
		expect(events.slice(0, firstRetryIdx).at(-1)?.type).toBe('message_end');

		// The turn recovered: final assistant message came from model-2.
		const finalAssistant = [...messages].reverse().find((m) => m.role === 'assistant') as AssistantMessage;
		expect(finalAssistant.stopReason).toBe('stop');
		expect(finalAssistant.model).toBe('model-2');
		// The turn ends cleanly (no error surfaced at agent_end).
		expect(events.at(-1)?.type).toBe('agent_end');
	});

	it('emits no fallback event when the last model in the chain fails', async () => {
		const m0 = fakeModel('prov0', 'model-0');
		const m1 = fakeModel('prov1', 'model-1');

		const streamFn = vi.fn((model: any) => errorStream(modelMessage(model), `boom ${model.id}`));

		const { events, messages } = await run(makeConfig(m0, [m1]), streamFn);

		expect(streamFn).toHaveBeenCalledTimes(2);
		const retries = events.filter((e) => e.type === 'stream_retry');
		// Only the m0→m1 switch; the m1 failure is terminal (no next model).
		expect(retries).toHaveLength(1);
		expect(retries[0]).toMatchObject({ scope: 'fallback', failedModel: 'model-0', model: 'model-1' });

		const finalAssistant = [...messages].reverse().find((m) => m.role === 'assistant') as AssistantMessage;
		expect(finalAssistant.stopReason).toBe('error');
		expect(finalAssistant.model).toBe('model-1');
		expect(finalAssistant.errorMessage).toBe('boom model-1');
		// Error turn still ends with agent_end (bridge surfaces the error card).
		expect(events.at(-1)?.type).toBe('agent_end');
	});

	it('emits a retry-scope stream_retry event when the retrying stream wrapper retries the same model', async () => {
		const m0 = fakeModel('prov0', 'model-0');

		// Base fails once, succeeds on the retry attempt.
		let calls = 0;
		const base = vi.fn((model: any) => {
			calls++;
			if (calls === 1) return errorStream(modelMessage(model), '503 service unavailable');
			return okStream(modelMessage(model));
		});
		const streamFn = createRetryingStreamFn(base, { maxRetries: 1, baseDelayMs: 1 });

		const { events, messages } = await run(makeConfig(m0, []), streamFn);

		// The wrapper retried internally — the loop only saw one logical stream.
		expect(base).toHaveBeenCalledTimes(2);

		const retries = events.filter((e) => e.type === 'stream_retry') as Extract<
			AgentEvent,
			{ type: 'stream_retry' }
		>[];
		expect(retries).toHaveLength(1);
		expect(retries[0]).toMatchObject({
			scope: 'retry',
			failedProvider: 'prov0',
			failedModel: 'model-0',
			provider: 'prov0',
			model: 'model-0',
			attempt: 1,
			maxRetries: 1,
			delayMs: 1,
			errorMessage: '503 service unavailable',
		});

		const finalAssistant = [...messages].reverse().find((m) => m.role === 'assistant') as AssistantMessage;
		expect(finalAssistant.stopReason).toBe('stop');
		expect(finalAssistant.model).toBe('model-0');
		expect(events.at(-1)?.type).toBe('agent_end');
	});

	it('pins a successful fallback model for the rest of the run (sticky fallback)', async () => {
		const m0 = fakeModel('prov0', 'model-0');
		const m1 = fakeModel('prov1', 'model-1');

		const streamFn = vi.fn((model: any) => {
			if (model.id === 'model-0') return errorStream(modelMessage(model), 'boom 0');
			return okStream(modelMessage(model));
		});

		// Two steering messages → two turns: turn 1 fails over to model-1,
		// turn 2 must call model-1 directly (pinned) instead of retrying the
		// failing primary first.
		let steeringCalls = 0;
		const config: AgentLoopConfig = {
			...makeConfig(m0, [m1]),
			getSteeringMessages: async () =>
				steeringCalls++ < 2
					? [{ role: 'user', content: `steer ${steeringCalls}`, timestamp: Date.now() } as any]
					: [],
		};

		const { events } = await run(config, streamFn);

		// Call order proves stickiness: turn 1 = model-0 (fail) → model-1;
		// turn 2 = model-1 only, no model-0 retry.
		expect(streamFn.mock.calls.map((c: any[]) => c[0].id)).toEqual(['model-0', 'model-1', 'model-1']);

		// Only turn 1 produced a fallback event.
		const retries = events.filter((e) => e.type === 'stream_retry');
		expect(retries).toHaveLength(1);
		expect(events.at(-1)?.type).toBe('agent_end');
	});
});
