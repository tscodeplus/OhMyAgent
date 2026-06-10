import { describe, it, expect, vi } from 'vitest';
import { createTransformContext } from '../../src/agent/context-transform.js';

const { mockCompressContext, mockEstimateTokens } = vi.hoisted(() => ({
  mockCompressContext: vi.fn(),
  mockEstimateTokens: vi.fn(),
}));

vi.mock('../../src/agent/compress.js', async () => {
  const actual = await vi.importActual('../../src/agent/compress.js');
  return {
    ...(actual as any),
    compressContext: mockCompressContext,
    estimateTokens: mockEstimateTokens,
  };
});

function makeMessage(role: string, index: number) {
  return { role, content: `msg-${index}`, timestamp: Date.now() + index };
}

describe('createTransformContext', () => {
  it('keeps all messages when fewer than maxMessages', async () => {
    const transform = createTransformContext({ maxMessages: 5 });
    const messages = [makeMessage('user', 1), makeMessage('assistant', 2), makeMessage('user', 3)];
    const result = await transform(messages);
    expect(result).toHaveLength(3);
    expect(result.map((m: any) => m.content)).toEqual(['msg-1', 'msg-2', 'msg-3']);
  });

  it('keeps all messages when exactly maxMessages', async () => {
    const transform = createTransformContext({ maxMessages: 3 });
    const messages = [
      makeMessage('user', 1),
      makeMessage('assistant', 2),
      makeMessage('user', 3),
    ];
    const result = await transform(messages);
    expect(result).toHaveLength(3);
  });

  it('trims to last N messages when exceeding maxMessages', async () => {
    const transform = createTransformContext({ maxMessages: 3 });
    const messages = [
      makeMessage('user', 1),
      makeMessage('assistant', 2),
      makeMessage('user', 3),
      makeMessage('assistant', 4),
      makeMessage('user', 5),
    ];
    const result = await transform(messages);
    expect(result).toHaveLength(3);
    expect(result.map((m: any) => m.content)).toEqual(['msg-3', 'msg-4', 'msg-5']);
  });

  it('preserves system message at index 0 when trimming', async () => {
    const transform = createTransformContext({ maxMessages: 2 });
    const messages = [
      { role: 'system', content: 'You are helpful.', timestamp: 0 },
      makeMessage('user', 1),
      makeMessage('assistant', 2),
      makeMessage('user', 3),
      makeMessage('assistant', 4),
    ];
    const result = await transform(messages);
    expect(result).toHaveLength(3);
    expect(result[0].role).toBe('system');
    expect(result[0].content).toBe('You are helpful.');
    expect(result[1].content).toBe('msg-3');
    expect(result[2].content).toBe('msg-4');
  });

  it('trims normally when no system message present', async () => {
    const transform = createTransformContext({ maxMessages: 2 });
    const messages = [
      makeMessage('user', 1),
      makeMessage('assistant', 2),
      makeMessage('user', 3),
    ];
    const result = await transform(messages);
    expect(result).toHaveLength(2);
    expect(result.map((m: any) => m.content)).toEqual(['msg-2', 'msg-3']);
  });

  it('uses default maxMessages of 100', async () => {
    const transform = createTransformContext();
    const messages = Array.from({ length: 50 }, (_, i) => makeMessage('user', i));
    const result = await transform(messages);
    expect(result).toHaveLength(50);
  });

  it('does not mutate the original array', async () => {
    const transform = createTransformContext({ maxMessages: 2 });
    const messages = [makeMessage('user', 1), makeMessage('assistant', 2), makeMessage('user', 3)];
    await transform(messages);
    expect(messages).toHaveLength(3);
  });

  it('handles empty array', async () => {
    const transform = createTransformContext({ maxMessages: 5 });
    const result = await transform([]);
    expect(result).toHaveLength(0);
  });

  it('appends persona context after the original user text block', async () => {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 's1',
      personaContextProvider: () => '[用户画像]\n偏好简洁回复',
    });
    const result = await transform([{ role: 'user', content: 'hello' }]);

    expect(result[0].content).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'text', text: '[用户画像]\n偏好简洁回复\n\n---\n' },
    ]);
  });

  it('appends persona context for DeepSeek cache profile', async () => {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 's1',
      cacheProfile: 'deepseek',
      personaContextProvider: () => '[用户画像]\n偏好简洁回复',
    });
    const result = await transform([{ role: 'user', content: 'hello' }]);

    expect(result[0].content).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'text', text: '[用户画像]\n偏好简洁回复\n\n---\n' },
    ]);
  });

  it('skips repeated identical persona context for DeepSeek cache profile', async () => {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'deepseek-persona-repeat',
      cacheProfile: 'deepseek',
      personaContextProvider: () => '[用户画像]\n偏好简洁回复',
    });

    await transform([{ role: 'user', content: 'hello' }]);
    const second = await transform([{ role: 'user', content: 'hello again' }]);

    expect(second[0].content).toBe('hello again');
  });

  it('uses day-level date injection by default', async () => {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 's1',
      dateLanguage: 'zh-CN',
    });
    const result = await transform([{ role: 'user', content: 'hello' }]);

    expect(result[0].content[1].text).toMatch(/^\n\n\[当前日期:/);
    expect(result[0].content[1].text).not.toContain('当前时间');
  });

  it('adds precise time for time-sensitive requests', async () => {
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 's1',
      dateLanguage: 'zh-CN',
    });
    const result = await transform([{ role: 'user', content: '30分钟后提醒我开会' }]);

    expect(result[0].content[1].text).toMatch(/^\n\n\[当前日期:/);
    expect(result[0].content[2].text).toMatch(/^\n\n\[当前时间:/);
  });

  it('re-injects persona context when the stored persona changes for an existing session', async () => {
    let personaText = '[用户画像]\n用户喜欢被称呼为老板';
    const transform = createTransformContext({
      maxMessages: 10,
      sessionKey: 'feishu:user-1',
      personaContextProvider: () => personaText,
    });

    const first = await transform([{ role: 'user', content: '你好' }]);
    expect(first[0].content).toEqual([
      { type: 'text', text: '你好' },
      { type: 'text', text: '[用户画像]\n用户喜欢被称呼为老板\n\n---\n' },
    ]);

    const second = await transform([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '老板，你好' },
      { role: 'user', content: '再打个招呼' },
    ]);
    expect(second[2].content).toBe('再打个招呼');

    personaText = '[用户画像]\n用户喜欢被称呼为老大';
    const third = await transform([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '老板，你好' },
      { role: 'user', content: '再打个招呼' },
    ]);
    expect(third[2].content).toEqual([
      { type: 'text', text: '再打个招呼' },
      { type: 'text', text: '[用户画像]\n用户喜欢被称呼为老大\n\n---\n' },
    ]);
  });

  it('does not include persona text in memory retrieval queries', async () => {
    const memoryRetriever = {
      retrieve: vi.fn(async () => []),
    };
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 's1',
      autoRecall: true,
      memoryRetriever: memoryRetriever as any,
      personaContextProvider: () => '[用户画像]\nprefers TypeScript',
    });

    await transform([{ role: 'user', content: 'please inspect memory system' }]);

    expect(memoryRetriever.retrieve).toHaveBeenCalledWith(expect.objectContaining({
      query: 'please inspect memory system',
    }));
  });

  it('uses original user text for memory query and filters stale current-time memories', async () => {
    const memoryRetriever = {
      retrieve: vi.fn(async () => [
        { content: '用户当前时间为2026年5月19日周二09:24（GMT+8）' },
        { content: '用户偏好使用中文交流' },
      ]),
    };
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'memory-filter',
      dateLanguage: 'zh-CN',
      autoRecall: true,
      autoRecallFrequency: 'every',
      memoryRetriever: memoryRetriever as any,
    });

    const result = await transform([{ role: 'user', content: '哈喽朋友你好' }]);

    expect(memoryRetriever.retrieve).toHaveBeenCalledWith(expect.objectContaining({
      query: '哈喽朋友你好',
      topK: 5,
    }));
    const memoryBlock = result[0].content.find((b: any) => b.text?.includes('Relevant remembered information'));
    expect(memoryBlock.text).toContain('用户偏好使用中文交流');
    expect(memoryBlock.text).not.toContain('用户当前时间为');
  });

  it('skips repeated identical memory context for DeepSeek cache profile', async () => {
    const memoryRetriever = {
      retrieve: vi.fn(async () => [{ content: '用户偏好使用中文交流' }]),
    };
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'deepseek-memory-repeat',
      cacheProfile: 'deepseek',
      autoRecall: true,
      autoRecallFrequency: 'every',
      memoryRetriever: memoryRetriever as any,
    });

    const first = await transform([{ role: 'user', content: '哈喽朋友你好' }]);
    const second = await transform([{ role: 'user', content: '哈喽朋友你好' }]);

    expect(first[0].content.some((b: any) => b.text?.includes('Relevant remembered information'))).toBe(true);
    expect(second[0].content).toBe('哈喽朋友你好');
  });

  it('uses maxRefsInContext and preserveInMessages for offload archive hints', async () => {
    const records = [
      { seq: 1, nodeId: 'node-001', summary: 'one', toolName: 'shell', status: 'success', refPath: '001-shell.md' },
      { seq: 2, nodeId: 'node-002', summary: 'two', toolName: 'shell', status: 'success', refPath: '002-shell.md' },
      { seq: 3, nodeId: 'node-003', summary: 'three', toolName: 'shell', status: 'success', refPath: '003-shell.md' },
      { seq: 4, nodeId: 'node-004', summary: 'four', toolName: 'shell', status: 'success', refPath: '004-shell.md' },
    ];
    const transform = createTransformContext({
      maxMessages: 2,
      sessionKey: 's1',
      offloadConfig: { enabled: true, maxRefsInContext: 2, preserveInMessages: 1 },
      offloadStore: {
        getSessionRecords: () => records,
        getSessionDirPath: () => '/tmp/offload/s1',
      } as any,
    });
    const messages = [
      makeMessage('user', 1),
      makeMessage('assistant', 2),
      makeMessage('user', 3),
      makeMessage('assistant', 4),
      makeMessage('user', 5),
    ];

    const result = await transform(messages);
    const firstUser = result.find((m: any) => m.role === 'user');
    const hint = firstUser.content[0].text;

    expect(hint).toContain('node-002');
    expect(hint).toContain('node-003');
    expect(hint).not.toContain('node-001');
    expect(hint).not.toContain('node-004');
  });

  it('logs when mermaid canvas context is injected', async () => {
    const logger = { debug: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 's1',
      mermaidCanvasConfig: { enabled: true, injectFormat: 'summary', maxNodesInContext: 5 },
      mermaidCanvas: {
        getAllNodes: () => [{ id: 'node-001', status: 'success' }],
        toContextSummary: () => '[任务画布]\n- node-001 done',
        toMermaid: () => 'flowchart LR',
        getCurrentPhase: () => '执行',
      } as any,
      logger: logger as any,
    });

    const result = await transform([{ role: 'user', content: 'continue' }]);

    expect(result[0].content).toEqual([
      { type: 'text', text: 'continue' },
      { type: 'text', text: '\n\n---\n[任务画布]\n- node-001 done' },
    ]);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: 's1', nodeCount: 1, injectFormat: 'summary' }),
      'Mermaid canvas injected into context',
    );
  });

  it('skips repeated static mermaid canvas for casual DeepSeek turns', async () => {
    const logger = { debug: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'deepseek-canvas-repeat',
      cacheProfile: 'deepseek',
      mermaidCanvasConfig: { enabled: true, injectFormat: 'summary', maxNodesInContext: 5 },
      mermaidCanvas: {
        getAllNodes: () => [{ id: 'node-001', status: 'success' }],
        toContextSummary: () => '[任务画布]\n- node-001 done',
        toMermaid: () => 'flowchart LR',
        getCurrentPhase: () => '执行',
      } as any,
      logger: logger as any,
    });

    const first = await transform([{ role: 'user', content: 'continue' }]);
    const second = await transform([{ role: 'user', content: 'hello' }]);

    expect(first[0].content.some((b: any) => b.text?.includes('[任务画布]'))).toBe(true);
    expect(second[0].content).toBe('hello');
  });
});

// ─── v9: Pi-style auto context compression integration ───

function makeCompressConfig() {
  return { enabled: true, reserveTokens: 1000, keepRecentTokens: 200 };
}

describe('auto compression in transformContext (pi-style)', () => {
  beforeEach(() => {
    mockCompressContext.mockReset();
    mockEstimateTokens.mockReset();
  });

  it('triggers compression when estimatedTokens > contextWindow - reserveTokens', async () => {
    // contextWindow=5000, reserveTokens=1000 → trigger at 4000
    // estimateTokens returns 5000 > 4000 → trigger
    mockEstimateTokens.mockReturnValue(5000);
    const summaryMsg = { role: 'user' as const, content: [{ type: 'text' as const, text: '## 目标\n...' }] };
    mockCompressContext.mockResolvedValue({
      summaryMessage: summaryMsg,
      compressedIndex: 5,
      summary: '## 目标\n...',
    });

    const transform = createTransformContext({
      maxMessages: 100,
      sessionKey: 'test-1',
      compressConfig: {
        config: makeCompressConfig(),
        contextWindow: 5000,
        mainModelRef: 'deepseek/model',
        globalFallbackRefs: [],
        apiKeys: {},
        baseUrls: {},
      },
    });

    const messages = Array.from({ length: 10 }, (_, i) => makeMessage('user', i));

    const result = await transform(messages);

    expect(mockCompressContext).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(6); // 1 summary + 5 recent (10 - 5 compressedIndex)
    expect(result[0]).toBe(summaryMsg);
  });

  it('skips compression when below threshold', async () => {
    // contextWindow=100000, reserveTokens=1000 → trigger at 99000
    // estimateTokens returns 1000 < 99000 → no trigger
    mockEstimateTokens.mockReturnValue(1000);

    const transform = createTransformContext({
      maxMessages: 100,
      sessionKey: 'test-2',
      compressConfig: {
        config: makeCompressConfig(),
        contextWindow: 100000,
        mainModelRef: 'deepseek/model',
        globalFallbackRefs: [],
        apiKeys: {},
        baseUrls: {},
      },
    });

    const messages = Array.from({ length: 10 }, (_, i) => makeMessage('user', i));
    const result = await transform(messages);

    expect(mockCompressContext).not.toHaveBeenCalled();
    expect(result).toHaveLength(10);
  });

  it('uses a lower compression threshold for DeepSeek cache profile', async () => {
    mockEstimateTokens.mockReturnValue(25000);
    const summaryMsg = { role: 'user' as const, content: [{ type: 'text' as const, text: 'summary' }] };
    mockCompressContext.mockResolvedValue({
      summaryMessage: summaryMsg,
      compressedIndex: 5,
      summary: 'summary',
    });

    const transform = createTransformContext({
      maxMessages: 100,
      sessionKey: 'test-deepseek',
      cacheProfile: 'deepseek',
      compressConfig: {
        config: { enabled: true, reserveTokens: 1000, keepRecentTokens: 20000 },
        contextWindow: 100000,
        mainModelRef: 'deepseek/model',
        globalFallbackRefs: [],
        apiKeys: {},
        baseUrls: {},
      },
    });

    const messages = Array.from({ length: 10 }, (_, i) => makeMessage('user', i));
    await transform(messages);

    expect(mockCompressContext).toHaveBeenCalledTimes(1);
    expect(mockCompressContext).toHaveBeenCalledWith(expect.objectContaining({
      settings: { reserveTokens: 1000, keepRecentTokens: 4000 },
    }));
  });

  it('falls through to hard truncation when compression fails', async () => {
    mockEstimateTokens.mockReturnValue(5000);
    mockCompressContext.mockResolvedValue({ summaryMessage: null, compressedIndex: 0, summary: '' });

    const transform = createTransformContext({
      maxMessages: 5,
      sessionKey: 'test-3',
      compressConfig: {
        config: makeCompressConfig(),
        contextWindow: 5000,
        mainModelRef: 'deepseek/model',
        globalFallbackRefs: [],
        apiKeys: {},
        baseUrls: {},
      },
    });

    const messages = Array.from({ length: 10 }, (_, i) => makeMessage('user', i));
    const result = await transform(messages);

    expect(mockCompressContext).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(5); // hard truncation at maxMessages
  });

  it('skips compression when compressConfig is absent', async () => {
    const transform = createTransformContext({
      maxMessages: 100,
      sessionKey: 'test-4',
    });

    const messages = Array.from({ length: 15 }, (_, i) => makeMessage('user', i));
    const result = await transform(messages);

    expect(mockCompressContext).not.toHaveBeenCalled();
    expect(result).toHaveLength(15);
  });
});
