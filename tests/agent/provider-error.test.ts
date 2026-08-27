import { describe, it, expect } from 'vitest';
import { classifyProviderError, toChatError } from '../../src/agent/provider-error.js';

describe('classifyProviderError', () => {
  it('classifies 404 / not-found as model_not_found', () => {
    expect(classifyProviderError('404 status code (no body)')).toBe('model_not_found');
    expect(classifyProviderError("Function '...' Not found for account '...'")).toBe('model_not_found');
    expect(classifyProviderError('no such model nvidia/moonshotai/kimi-k2.6')).toBe('model_not_found');
  });

  it('classifies 429 / rate limit as rate_limited', () => {
    expect(classifyProviderError('429 Too Many Requests')).toBe('rate_limited');
    expect(classifyProviderError('rate limit exceeded, slow down')).toBe('rate_limited');
  });

  it('classifies 401/403 / api key as auth', () => {
    expect(classifyProviderError('401 Unauthorized')).toBe('auth');
    expect(classifyProviderError('invalid api key')).toBe('auth');
  });

  it('classifies timeouts / connection errors as network', () => {
    expect(classifyProviderError('ETIMEDOUT')).toBe('network');
    expect(classifyProviderError('502 Bad Gateway')).toBe('network');
    expect(classifyProviderError('503 Service Unavailable')).toBe('network');
  });

  it('falls back to unknown for unrecognized errors', () => {
    expect(classifyProviderError('500 Internal Server Error')).toBe('unknown');
    expect(classifyProviderError('something weird happened')).toBe('unknown');
  });
});

describe('toChatError', () => {
  it('builds a structured error with the failed model ref', () => {
    const err = toChatError('404 status code (no body)', 'nvidia/moonshotai/kimi-k2.6');
    expect(err).toEqual({
      kind: 'model_not_found',
      rawError: '404 status code (no body)',
      failedModels: ['nvidia/moonshotai/kimi-k2.6'],
    });
  });

  it('omits failedModels when no model ref is given', () => {
    const err = toChatError('429 Too Many Requests');
    expect(err.failedModels).toBeUndefined();
    expect(err.kind).toBe('rate_limited');
  });
});
