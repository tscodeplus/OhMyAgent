// ---------------------------------------------------------------------------
// Tests for STT Provider factory and transcribeWithFallback
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { createSTTProviders, transcribeWithFallback } from '../../../src/media-providers/stt/factory.js';
import type { STTProvider, STTInput, STTResult } from '../../../src/media-providers/stt/types.js';

// ---------------------------------------------------------------------------
// Mock providers
// ---------------------------------------------------------------------------

class MockWorkingProvider implements STTProvider {
  readonly id = 'mock-working';
  isAvailable(): boolean { return true; }
  async transcribe(_input: STTInput): Promise<STTResult> {
    return { text: 'hello world', durationMs: 1000, providerId: this.id };
  }
}

class MockFailingProvider implements STTProvider {
  readonly id = 'mock-failing';
  isAvailable(): boolean { return true; }
  async transcribe(_input: STTInput): Promise<STTResult> {
    throw new Error('Simulated API failure');
  }
}

class MockUnavailableProvider implements STTProvider {
  readonly id = 'mock-unavailable';
  isAvailable(): boolean { return false; }
  async transcribe(_input: STTInput): Promise<STTResult> {
    return { text: '', durationMs: 0, providerId: this.id };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createSTTProviders', () => {
  it('creates GenericSTTProvider from generic config', () => {
    const providers = createSTTProviders([
      { id: 'generic', endpoint: 'http://localhost:8000/api/recognize', requestType: 'multipart' },
    ]);
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe('generic');
  });

  it('creates OpenAIWhisperProvider from openai-whisper config', () => {
    const providers = createSTTProviders([
      { id: 'openai-whisper', apiKey: 'sk-test' },
    ]);
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe('openai-whisper');
  });

  it('skips generic provider without endpoint', () => {
    const providers = createSTTProviders([
      { id: 'generic', requestType: 'multipart' },
    ]);
    expect(providers).toHaveLength(0);
  });

  it('skips openai-whisper without apiKey', () => {
    const providers = createSTTProviders([
      { id: 'openai-whisper' },
    ]);
    expect(providers).toHaveLength(0);
  });

  it('skips unknown provider id', () => {
    const providers = createSTTProviders([
      { id: 'unknown-provider', apiKey: 'test' },
    ]);
    expect(providers).toHaveLength(0);
  });

  it('returns multiple providers in config order', () => {
    const providers = createSTTProviders([
      { id: 'generic', endpoint: 'http://localhost:8000', requestType: 'multipart' },
      { id: 'openai-whisper', apiKey: 'sk-test' },
    ]);
    expect(providers).toHaveLength(2);
    expect(providers[0].id).toBe('generic');
    expect(providers[1].id).toBe('openai-whisper');
  });
});

describe('transcribeWithFallback', () => {
  it('returns result from the first working provider', async () => {
    const providers: STTProvider[] = [
      new MockWorkingProvider(),
    ];
    const result = await transcribeWithFallback(providers, { audioPath: '/tmp/test.ogg' });
    expect(result.text).toBe('hello world');
    expect(result.providerId).toBe('mock-working');
  });

  it('falls back to second provider when first fails', async () => {
    const providers: STTProvider[] = [
      new MockFailingProvider(),
      new MockWorkingProvider(),
    ];
    const result = await transcribeWithFallback(providers, { audioPath: '/tmp/test.ogg' });
    expect(result.text).toBe('hello world');
    expect(result.providerId).toBe('mock-working');
  });

  it('throws when all providers fail', async () => {
    const providers: STTProvider[] = [
      new MockFailingProvider(),
      new MockFailingProvider(),
    ];
    await expect(transcribeWithFallback(providers, { audioPath: '/tmp/test.ogg' }))
      .rejects.toThrow('All providers failed');
  });

  it('throws when no provider is available', async () => {
    const providers: STTProvider[] = [
      new MockUnavailableProvider(),
    ];
    await expect(transcribeWithFallback(providers, { audioPath: '/tmp/test.ogg' }))
      .rejects.toThrow('No provider available');
  });
});
