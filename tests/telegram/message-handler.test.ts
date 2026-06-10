import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupMessageHandlers } from '../../extensions/channel-telegram/message-handler.js';
import type { TelegramConfig } from '../../extensions/channel-telegram/telegram-types.js';

const proxyAgents: Array<{ proxyUrl: string }> = [];

vi.mock('undici', () => ({
  ProxyAgent: vi.fn().mockImplementation((proxyUrl: string) => {
    const agent = { proxyUrl };
    proxyAgents.push(agent);
    return agent;
  }),
}));

const baseConfig: TelegramConfig = {
  botToken: 'token',
  mode: 'polling',
  webhookPort: 8443,
  allowedUsers: [],
  allowedGroups: [],
  streamMode: 'edit',
  textLimit: 4096,
  streamIntervalMs: 500,
};

describe('telegram message handler', () => {
  const originalFetch = globalThis.fetch;
  const originalHttpsProxy = process.env.HTTPS_PROXY;
  const originalHttpProxy = process.env.HTTP_PROXY;

  beforeEach(() => {
    proxyAgents.length = 0;
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = originalHttpsProxy;
    if (originalHttpProxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = originalHttpProxy;
    vi.restoreAllMocks();
  });

  it('uses telegram.proxyUrl for auto-transcribed audio file downloads', async () => {
    const handlers: Array<(ctx: any) => Promise<void>> = [];
    const bot = {
      use: vi.fn(),
      catch: vi.fn(),
      on: vi.fn((_events, handler) => handlers.push(handler)),
      api: {
        getFile: vi.fn(async () => ({ file_path: 'voice.ogg' })),
      },
    };
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    globalThis.fetch = fetchMock as any;

    const agentService = {
      execute: vi.fn(async () => undefined),
      resolveApproval: vi.fn(),
    };
    const api = {
      getConfig: () => ({
        showToolCalls: true,
        footer: {},
        tools: { fileRead: { allowedRoots: [], deniedPatterns: [] } },
      }),
    };
    const sttTranscriber = vi.fn(async () => 'transcribed voice');

    setupMessageHandlers(
      bot as any,
      { ...baseConfig, proxyUrl: 'http://127.0.0.1:7897' },
      agentService as any,
      {} as any,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      api as any,
      sttTranscriber,
      { enabled: true, autoTranscribe: true },
    );

    const mediaHandler = handlers[1];
    await mediaHandler({
      me: { username: 'agentbot' },
      chat: { id: 123, type: 'private' },
      message: {
        message_id: 1,
        chat: { id: 123, type: 'private' },
        from: { id: 456 },
        voice: { file_id: 'file-id', duration: 2 },
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.org/file/bottoken/voice.ogg',
      expect.objectContaining({
        dispatcher: expect.objectContaining({ proxyUrl: 'http://127.0.0.1:7897' }),
      }),
    );
    expect(agentService.execute).toHaveBeenCalledWith(
      'transcribed voice',
      expect.objectContaining({
        sessionId: 'telegram:123',
        chatId: '123',
        channel: 'telegram',
      }),
    );
  });
});
