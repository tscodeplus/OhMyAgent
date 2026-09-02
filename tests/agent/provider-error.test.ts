import { describe, it, expect } from 'vitest';
import {
  classifyProviderError,
  buildFriendlyErrorMessage,
  qualifyModelRef,
  toChatError,
} from '../../src/agent/provider-error.js';
import { changeI18nLocale } from '../../src/i18n/i18n-service.js';

describe('classifyProviderError', () => {
  it('classifies 404 / not-found as model_not_found', () => {
    expect(classifyProviderError('404 status code (no body)')).toBe('model_not_found');
    expect(classifyProviderError("Function '...' Not found for account '...'")).toBe(
      'model_not_found',
    );
    expect(classifyProviderError('no such model nvidia/moonshotai/kimi-k2.6')).toBe(
      'model_not_found',
    );
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

  // pi-mono composes OpenAI-compatible gateway rejections into messages shaped
  // like "401: Model X is not supported" (status prefix + HTTP body, see
  // ai/utils/error-body.ts). The model wording must win over the 401 status.
  it('prefers model wording over auth status codes (gateway 401 + not-supported body)', () => {
    expect(classifyProviderError('401: Model opencodezen/gpt-x is not supported')).toBe(
      'model_not_found',
    );
    expect(classifyProviderError('401 Unauthorized — unsupported model "foo-bar"')).toBe(
      'model_not_found',
    );
    expect(classifyProviderError("400 invalid request: unknown model 'x/y'")).toBe(
      'model_not_found',
    );
  });
});

describe('buildFriendlyErrorMessage', () => {
  it('renders an English friendly message + model + raw line for locale en', async () => {
    await changeI18nLocale('en');
    try {
      const out = buildFriendlyErrorMessage(
        '404 status code (no body)',
        'nvidia/moonshotai/kimi-k2.6',
      );
      expect(out).toContain('Model or API key misconfigured');
      expect(out).toContain('(nvidia/moonshotai/kimi-k2.6)');
      expect(out).toContain('Raw error: 404 status code (no body)');
    } finally {
      await changeI18nLocale('en');
    }
  });

  it('renders a Chinese friendly message + raw line for locale zh-CN', async () => {
    await changeI18nLocale('zh-CN');
    try {
      const out = buildFriendlyErrorMessage('429 Too Many Requests');
      expect(out).toContain('服务限流');
      expect(out).toContain('原始错误：429 Too Many Requests');
      expect(out).not.toContain('('); // full-width punctuation in zh mode
    } finally {
      await changeI18nLocale('en');
    }
  });

  it('omits the model line when no model ref is given (en)', async () => {
    await changeI18nLocale('en');
    try {
      const out = buildFriendlyErrorMessage('500 boom');
      expect(out.split('\n').length).toBe(2);
      expect(out).toContain('Raw error: 500 boom');
    } finally {
      await changeI18nLocale('en');
    }
  });
});

describe('qualifyModelRef', () => {
  it('prefixes a bare model id with its provider slug', () => {
    expect(qualifyModelRef('openai', 'gpt-4o')).toBe('openai/gpt-4o');
  });

  it('passes through already-qualified refs unchanged', () => {
    expect(qualifyModelRef('openai', 'openai/gpt-4o')).toBe('openai/gpt-4o');
  });

  it('tolerates missing provider / missing model', () => {
    expect(qualifyModelRef(undefined, 'gpt-4o')).toBe('gpt-4o');
    expect(qualifyModelRef(null, 'gpt-4o')).toBe('gpt-4o');
    expect(qualifyModelRef('openai', undefined)).toBeUndefined();
    expect(qualifyModelRef(undefined, undefined)).toBeUndefined();
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
