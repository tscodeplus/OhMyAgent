import { describe, it, expect } from 'vitest';
import { convertToLlm } from '../../src/agent/convert-to-llm.js';

function makeMessage(role: string, content = 'test') {
  return { role, content, timestamp: Date.now() };
}

describe('convertToLlm', () => {
  it('keeps user messages', () => {
    const messages = [makeMessage('user')];
    const result = convertToLlm(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
  });

  it('keeps assistant messages', () => {
    const messages = [makeMessage('assistant')];
    const result = convertToLlm(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('assistant');
  });

  it('keeps toolResult messages', () => {
    const messages = [makeMessage('toolResult')];
    const result = convertToLlm(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('toolResult');
  });

  it('removes system messages', () => {
    const messages = [makeMessage('system')];
    const result = convertToLlm(messages);
    expect(result).toHaveLength(0);
  });

  it('removes unknown role messages', () => {
    const messages = [makeMessage('notification'), makeMessage('custom')];
    const result = convertToLlm(messages);
    expect(result).toHaveLength(0);
  });

  it('handles mixed roles correctly', () => {
    const messages = [
      makeMessage('system'),
      makeMessage('user', 'hello'),
      makeMessage('assistant', 'hi'),
      makeMessage('toolResult', 'result'),
      makeMessage('notification'),
      makeMessage('user', 'bye'),
    ];
    const result = convertToLlm(messages);
    expect(result).toHaveLength(4);
    expect(result.map((m: any) => m.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
      'user',
    ]);
  });

  it('handles empty array', () => {
    const result = convertToLlm([]);
    expect(result).toHaveLength(0);
  });

  it('does not mutate the original array', () => {
    const messages = [makeMessage('system'), makeMessage('user')];
    convertToLlm(messages);
    expect(messages).toHaveLength(2);
  });
});
