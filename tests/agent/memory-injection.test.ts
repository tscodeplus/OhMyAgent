import { describe, it, expect } from 'vitest';
import { createTransformContext } from '../../src/agent/context-transform.js';

function makeMessage(role: string, content: string) {
  return { role, content, timestamp: Date.now() };
}

describe('Context transform', () => {
  it('returns a copy of the messages when under the limit', async () => {
    const transform = createTransformContext({ maxMessages: 10 });
    const messages = [
      makeMessage('user', 'hello'),
      makeMessage('assistant', 'hi there'),
      makeMessage('user', 'how are you?'),
    ];

    const result = await transform(messages);

    expect(result).toHaveLength(3);
    expect(result).toEqual(messages);
    // Should not mutate original
    expect(result).not.toBe(messages);
  });

  it('trims messages when over maxMessages limit', async () => {
    const transform = createTransformContext({ maxMessages: 2 });
    const messages = [
      makeMessage('system', 'You are helpful.'),
      makeMessage('user', 'message 1'),
      makeMessage('assistant', 'reply 1'),
      makeMessage('user', 'message 2'),
    ];

    const result = await transform(messages);

    // Keeps system prompt + last 2 non-system messages
    expect(result).toHaveLength(3);
    expect(result[0].content).toBe('You are helpful.');
    expect(result[1].content).toBe('reply 1');
    expect(result[2].content).toBe('message 2');
  });

  it('preserves system prompt when trimming', async () => {
    const transform = createTransformContext({ maxMessages: 1 });
    const messages = [
      makeMessage('system', 'System prompt'),
      makeMessage('user', 'hello'),
      makeMessage('assistant', 'hi'),
    ];

    const result = await transform(messages);

    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('System prompt');
    expect(result[1].content).toBe('hi');
  });

  it('trims without system prompt when none exists', async () => {
    const transform = createTransformContext({ maxMessages: 1 });
    const messages = [
      makeMessage('user', 'first'),
      makeMessage('assistant', 'second'),
      makeMessage('user', 'third'),
    ];

    const result = await transform(messages);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('third');
  });

  it('defaults to maxMessages 100 when no options provided', async () => {
    const transform = createTransformContext();
    const messages = Array.from({ length: 50 }, (_, i) => makeMessage('user', `msg ${i}`));

    const result = await transform(messages);

    expect(result).toHaveLength(50);
  });

  it('returns a copy and does not mutate the original', async () => {
    const transform = createTransformContext();
    const messages = [makeMessage('system', 'sys'), makeMessage('user', 'hello')];
    const original = [...messages];

    await transform(messages);

    expect(messages).toEqual(original);
  });
});
