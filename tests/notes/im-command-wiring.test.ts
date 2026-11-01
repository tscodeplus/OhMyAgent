import { describe, it, expect, vi } from 'vitest';
import { createFeishuServices } from '../../src/app/composers/feishu-services.js';
import type { AppConfig } from '../../src/app/types.js';
import type { NotesService } from '../../src/notes/service-contract.js';

/**
 * `/note` reaches IM channels through `commandDeps`, which is built once in
 * `createFeishuServices` and shared by every channel extension (Feishu,
 * Telegram, WeChat, QQ read it out of `servicesMap`).
 *
 * That makes the wiring a single line, and a single line that can be missing:
 * `handleCommand` treats an absent `notes` dep as "the layer is switched off",
 * so forgetting to pass it does not crash or log — `/note` in a real chat just
 * answers "notes are off" forever while the WebUI works fine. This is the test
 * that fails in that case.
 */

function makeConfig(): AppConfig {
  return {
    feishu: {
      enabled: true,
      appId: 'app',
      appSecret: 'secret',
      allowedUsers: [],
      botName: 'bot',
    },
    tools: { fileRead: { allowedRoots: [], deniedPatterns: [] } },
  } as unknown as AppConfig;
}

function makeServices(notesService?: NotesService) {
  const servicesMap = new Map<string, unknown>();
  const result = createFeishuServices({
    config: makeConfig(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    agentService: {} as never,
    skillRegistry: { getSkills: () => [], load: vi.fn(async () => {}) } as never,
    cronService: {} as never,
    feishuClient: {} as never,
    agentManager: { list: () => [], get: () => undefined } as never,
    extensionManager: {} as never,
    chatQueue: {} as never,
    servicesMap,
    notesService,
  });
  return { result, servicesMap };
}

describe('/note IM wiring', () => {
  it('shares the notes service through commandDeps', () => {
    const notesService = { capture: vi.fn() } as unknown as NotesService;
    const { result } = makeServices(notesService);

    expect(result.commandDeps.notes).toBe(notesService);
  });

  it('leaves the dep absent when the layer is switched off', () => {
    const { result } = makeServices(undefined);

    // Absent, not a stub: this is what makes `/note` say "notes are off"
    // instead of forwarding the text to the agent as a question.
    expect(result.commandDeps.notes).toBeUndefined();
  });
});
