import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PersonaDistiller } from '../../src/memory/persona-distiller';
import type { DistillerLLM, PersonaStore, PreferenceQuery } from '../../src/memory/persona-distiller';
import type { Memory } from '../../src/memory/repositories/memory-repository';
import type { UserPersona, PartialPersona } from '../../src/memory/persona-model';
import { createEmptyPersona } from '../../src/memory/persona-model';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idCounter = 0;

function makePref(content: string, created_at: string, updated_at = created_at): Memory {
  idCounter++;
  return {
    id: `pref-${Date.now()}-${idCounter}`,
    scope: 'user',
    scope_key: 'session-1',
    kind: 'preference',
    content,
    metadata: null,
    agent_id: null,
    visibility: 'shared',
    created_at,
    updated_at,
  };
}

function makeMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    child: vi.fn(() => makeMockLogger()),
    level: 'debug',
  } as any;
}

// ---------------------------------------------------------------------------
// Timestamp tiers — 3 groups for fine-grained test control
//   oldT = 4 items
//   midT = 3 items
//   newT = 3 items
// ---------------------------------------------------------------------------

const oldT = '2026-05-13T12:00:00.000Z';
const midT = '2026-05-14T12:00:00.000Z';
const newT = '2026-05-15T12:00:00.000Z';

const samplePreferences = [
  // 4 old
  makePref('用户喜欢使用 shell 工具进行文件操作', oldT),
  makePref('用户是 Android 开发者', oldT),
  makePref('用户习惯使用 TypeScript', oldT),
  makePref('用户偏好简洁的中文回复', oldT),
  // 3 mid
  makePref('用户常用 Node.js 运行环境', midT),
  makePref('用户使用 Termux 作为开发平台', midT),
  makePref('用户擅长 git 版本控制', midT),
  // 3 new
  makePref('用户使用 pnpm 作为包管理器', newT),
  makePref('用户编写测试优先的代码', newT),
  makePref('用户偏好飞书作为沟通渠道', newT),
];

const validFullPersonaJson = JSON.stringify({
  version: 1,
  lastUpdated: newT,
  summary: '一位经验丰富的 Android 开发者，熟悉后端开发',
  preferences: {
    tools: ['shell', 'git', 'pnpm'],
    languages: ['TypeScript', 'Node.js'],
    workflows: ['test-first'],
    communication: '简洁的中文',
  },
  skills: {
    known: ['Android', 'TypeScript', 'Node.js'],
    learning: [],
  },
  context: {
    device: 'Termux on Android',
    environment: 'Node.js, pnpm',
    timezone: 'Asia/Shanghai',
    activeProjects: ['OhMyAgent'],
  },
  stats: {
    totalSessions: 0,
    totalMessages: 0,
    lastActive: '',
  },
});

const validPartialJson = JSON.stringify({
  summary: '一位开始学习 Rust 的 Android 开发者',
  preferences: {
    languages: ['Rust'],
  },
  skills: {
    learning: ['Rust'],
  },
});

// ---------------------------------------------------------------------------

describe('PersonaDistiller', () => {
  let mockMemoryRepo: PreferenceQuery;
  let mockPersonaStore: PersonaStore;
  let mockLLM: DistillerLLM;
  let mockLogger: ReturnType<typeof makeMockLogger>;
  let distiller: PersonaDistiller;

  beforeEach(() => {
    idCounter = 0;
    mockMemoryRepo = { findByScopeKind: vi.fn() };
    mockPersonaStore = { get: vi.fn(), save: vi.fn() };
    mockLLM = { call: vi.fn() };
    mockLogger = makeMockLogger();
    distiller = new PersonaDistiller(mockLLM, mockMemoryRepo, mockPersonaStore, mockLogger, {
      outputLanguage: 'Simplified Chinese',
    });
  });

  // ── distillFull ──

  describe('distillFull', () => {
    it('returns a complete UserPersona from 10 preference memories', async () => {
      vi.mocked(mockMemoryRepo.findByScopeKind).mockReturnValue(samplePreferences);
      vi.mocked(mockLLM.call).mockResolvedValue(validFullPersonaJson);

      const result = await distiller.distillFull();

      expect(result.version).toBe(1);
      expect(result.summary).toBe('一位经验丰富的 Android 开发者，熟悉后端开发');
      expect(result.preferences.tools).toEqual(['shell', 'git', 'pnpm']);
      expect(result.preferences.languages).toEqual(['TypeScript', 'Node.js']);
      expect(result.skills.known).toContain('Android');
      expect(result.context.device).toBe('Termux on Android');

      // Verify LLM was called with correct prompts
      expect(mockLLM.call).toHaveBeenCalledOnce();
      const [systemPrompt, userPrompt] = (mockLLM.call as any).mock.calls[0];
      expect(systemPrompt).toContain('persona analyst');
      expect(userPrompt).toContain('Preference list');
      expect(userPrompt).toContain('JSON Schema');
      expect(userPrompt).toContain('shell 工具');
      expect(userPrompt).toContain('飞书');
    });

    it('returns createEmptyPersona() when there are 0 preferences', async () => {
      vi.mocked(mockMemoryRepo.findByScopeKind).mockReturnValue([]);

      const result = await distiller.distillFull();

      expect(result.version).toBe(1);
      expect(result.summary).toBe('');
      expect(result.preferences.tools).toEqual([]);

      // LLM should NOT be called
      expect(mockLLM.call).not.toHaveBeenCalled();
    });

    it('gracefully handles LLM returning invalid JSON', async () => {
      vi.mocked(mockMemoryRepo.findByScopeKind).mockReturnValue(samplePreferences);
      vi.mocked(mockLLM.call).mockResolvedValue('这不是 JSON');

      const result = await distiller.distillFull();

      expect(result.version).toBe(1);
      expect(result.summary).toBe('');
    });

    it('handles JSON inside markdown code fences', async () => {
      vi.mocked(mockMemoryRepo.findByScopeKind).mockReturnValue(samplePreferences.slice(0, 3));
      vi.mocked(mockLLM.call).mockResolvedValue(
        '```json\n' + validFullPersonaJson + '\n```',
      );

      const result = await distiller.distillFull();

      expect(result.version).toBe(1);
      expect(result.preferences.tools).toEqual(['shell', 'git', 'pnpm']);
    });

    it('gracefully degrades when LLM throws', async () => {
      vi.mocked(mockMemoryRepo.findByScopeKind).mockReturnValue(samplePreferences);
      vi.mocked(mockLLM.call).mockRejectedValue(new Error('Network error'));

      const result = await distiller.distillFull();

      expect(result.version).toBe(1);
      expect(result.summary).toBe('');
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('parses LLM response with additional surrounding text', async () => {
      vi.mocked(mockMemoryRepo.findByScopeKind).mockReturnValue(samplePreferences.slice(0, 3));
      vi.mocked(mockLLM.call).mockResolvedValue(
        '以下是根据偏好生成的画像：\n' + validFullPersonaJson + '\n（完）',
      );

      const result = await distiller.distillFull();

      expect(result.version).toBe(1);
      expect(result.summary).toBe('一位经验丰富的 Android 开发者，熟悉后端开发');
    });
  });

  describe('rebuildFull', () => {
    it('persists a full persona rebuilt from current preferences', async () => {
      vi.mocked(mockMemoryRepo.findByScopeKind).mockReturnValue(samplePreferences);
      vi.mocked(mockLLM.call).mockResolvedValue(validFullPersonaJson);

      const rebuilt = await distiller.rebuildFull();

      expect(rebuilt).toBe(true);
      expect(mockPersonaStore.save).toHaveBeenCalledOnce();
      const saved = vi.mocked(mockPersonaStore.save).mock.calls[0][0];
      expect(saved.summary).toBe('一位经验丰富的 Android 开发者，熟悉后端开发');
      expect(saved.preferences.tools).toContain('pnpm');
    });

    it('preserves existing persona when full rebuild LLM fails', async () => {
      vi.mocked(mockMemoryRepo.findByScopeKind).mockReturnValue(samplePreferences);
      vi.mocked(mockLLM.call).mockRejectedValue(new Error('LLM error'));

      const rebuilt = await distiller.rebuildFull();

      expect(rebuilt).toBe(false);
      expect(mockPersonaStore.save).not.toHaveBeenCalled();
    });

    it('preserves existing persona when full rebuild returns invalid JSON', async () => {
      vi.mocked(mockMemoryRepo.findByScopeKind).mockReturnValue(samplePreferences);
      vi.mocked(mockLLM.call).mockResolvedValue('invalid json');

      const rebuilt = await distiller.rebuildFull();

      expect(rebuilt).toBe(false);
      expect(mockPersonaStore.save).not.toHaveBeenCalled();
    });

    it('resets persona when no preference memories remain', async () => {
      vi.mocked(mockMemoryRepo.findByScopeKind).mockReturnValue([]);

      const rebuilt = await distiller.rebuildFull();

      expect(rebuilt).toBe(true);
      expect(mockLLM.call).not.toHaveBeenCalled();
      expect(mockPersonaStore.save).toHaveBeenCalledOnce();
      expect(vi.mocked(mockPersonaStore.save).mock.calls[0][0].summary).toBe('');
    });
  });

  // ── distillIncremental ──

  describe('distillIncremental', () => {
    it('returns updated fields from 3 new preferences and existing persona', async () => {
      const existingPersona = createEmptyPersona();
      existingPersona.summary = '一位 Android 开发者';
      existingPersona.preferences.tools = ['shell', 'git'];
      existingPersona.lastUpdated = midT;

      vi.mocked(mockMemoryRepo.findByScopeKind).mockReturnValue(samplePreferences);
      vi.mocked(mockPersonaStore.get).mockReturnValue(existingPersona);
      vi.mocked(mockLLM.call).mockResolvedValue(validPartialJson);

      // `since` = shortly before newT → only the 3 newT prefs are "new"
      const since = '2026-05-15T10:00:00.000Z';
      const result = await distiller.distillIncremental(since);

      expect(result.summary).toBe('一位开始学习 Rust 的 Android 开发者');
      expect(result.preferences?.languages).toEqual(['Rust']);
      expect(result.skills?.learning).toEqual(['Rust']);

      // Fields not in response should be undefined
      expect(result.version).toBeUndefined();
      expect(result.preferences?.tools).toBeUndefined();
      expect(result.stats).toBeUndefined();

      // Verify LLM prompt includes existing persona + new preferences
      expect(mockLLM.call).toHaveBeenCalledOnce();
      const [, userPrompt] = (mockLLM.call as any).mock.calls[0];
      expect(userPrompt).toContain('Existing persona');
      expect(userPrompt).toContain('New preferences');
      // Only newT prefs (created_at > since) should appear in prompt
      expect(userPrompt).toContain('pnpm');
      expect(userPrompt).toContain('测试优先');
      expect(userPrompt).toContain('飞书');
    });

    it('returns {} when there are no new preferences', async () => {
      vi.mocked(mockMemoryRepo.findByScopeKind).mockReturnValue(samplePreferences);
      vi.mocked(mockPersonaStore.get).mockReturnValue(createEmptyPersona());

      // `since` after all prefs → 0 new
      const result = await distiller.distillIncremental('2026-05-16T00:00:00.000Z');

      expect(result).toEqual({});
      expect(mockLLM.call).not.toHaveBeenCalled();
    });

    it('detects SQLite datetime preferences newer than an ISO persona timestamp on the same day', async () => {
      const existingPersona = createEmptyPersona();
      existingPersona.summary = '用户曾被称呼为 Dei哥';
      existingPersona.lastUpdated = '2026-05-19T00:00:00.000Z';

      vi.mocked(mockMemoryRepo.findByScopeKind).mockReturnValue([
        makePref('用户希望被称呼为"老大"', '2026-05-19 11:38:22'),
      ]);
      vi.mocked(mockPersonaStore.get).mockReturnValue(existingPersona);
      vi.mocked(mockLLM.call).mockResolvedValue(JSON.stringify({
        summary: '用户希望被称呼为老大',
        preferences: { communication: '称呼用户为老大' },
      }));

      const result = await distiller.distillIncremental();

      expect(result.summary).toBe('用户希望被称呼为老大');
      expect(mockLLM.call).toHaveBeenCalledOnce();
      const [, userPrompt] = (mockLLM.call as any).mock.calls[0];
      expect(userPrompt).toContain('用户希望被称呼为"老大"');
    });

    it('includes preferences updated after the persona watermark', async () => {
      const existingPersona = createEmptyPersona();
      existingPersona.lastUpdated = '2026-05-19T00:00:00.000Z';

      vi.mocked(mockMemoryRepo.findByScopeKind).mockReturnValue([
        makePref('用户希望被称呼为Boss', '2026-05-18 09:00:00', '2026-05-19 11:00:00'),
      ]);
      vi.mocked(mockPersonaStore.get).mockReturnValue(existingPersona);
      vi.mocked(mockLLM.call).mockResolvedValue(JSON.stringify({
        preferences: { communication: '称呼用户为Boss' },
      }));

      const result = await distiller.distillIncremental();

      expect(result.preferences?.communication).toBe('称呼用户为Boss');
      expect(mockLLM.call).toHaveBeenCalledOnce();
    });

    it('returns {} when LLM call fails', async () => {
      vi.mocked(mockMemoryRepo.findByScopeKind).mockReturnValue(samplePreferences);
      vi.mocked(mockPersonaStore.get).mockReturnValue(createEmptyPersona());
      vi.mocked(mockLLM.call).mockRejectedValue(new Error('LLM error'));

      const result = await distiller.distillIncremental(oldT);

      expect(result).toEqual({});
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('returns {} when LLM returns invalid JSON', async () => {
      vi.mocked(mockMemoryRepo.findByScopeKind).mockReturnValue(samplePreferences);
      vi.mocked(mockPersonaStore.get).mockReturnValue(createEmptyPersona());
      vi.mocked(mockLLM.call).mockResolvedValue('invalid json content');

      const result = await distiller.distillIncremental(oldT);

      expect(result).toEqual({});
    });
  });

  // ── shouldDistill ──

  describe('shouldDistill', () => {
    it('returns true when 6 new preferences exceed default threshold of 5', async () => {
      vi.mocked(mockMemoryRepo.findByScopeKind).mockReturnValue(samplePreferences);

      const persona = createEmptyPersona();
      // lastUpdated before midT + newT → 3 (mid) + 3 (new) = 6 new
      persona.lastUpdated = '2026-05-14T10:00:00.000Z';
      vi.mocked(mockPersonaStore.get).mockReturnValue(persona);

      const result = await distiller.shouldDistill();
      expect(result).toBe(true);
    });

    it('returns false when 3 new preferences are below default threshold', async () => {
      vi.mocked(mockMemoryRepo.findByScopeKind).mockReturnValue(samplePreferences);

      const persona = createEmptyPersona();
      // lastUpdated between midT and newT → only newT (3) prefs are newer
      persona.lastUpdated = '2026-05-15T10:00:00.000Z';
      vi.mocked(mockPersonaStore.get).mockReturnValue(persona);

      const result = await distiller.shouldDistill();
      expect(result).toBe(false);
    });

    it('respects custom threshold parameter', async () => {
      vi.mocked(mockMemoryRepo.findByScopeKind).mockReturnValue(samplePreferences);

      const persona = createEmptyPersona();
      // lastUpdated before midT → 6 new, but threshold=10 → false
      persona.lastUpdated = '2026-05-14T10:00:00.000Z';
      vi.mocked(mockPersonaStore.get).mockReturnValue(persona);

      const result = await distiller.shouldDistill(10);
      expect(result).toBe(false);
    });

    it('returns true when new preferences reach the threshold', async () => {
      vi.mocked(mockMemoryRepo.findByScopeKind).mockReturnValue(samplePreferences);

      const persona = createEmptyPersona();
      persona.lastUpdated = '2026-05-15T10:00:00.000Z';
      vi.mocked(mockPersonaStore.get).mockReturnValue(persona);

      const result = await distiller.shouldDistill(3);
      expect(result).toBe(true);
    });

    it('counts SQLite datetime preferences newer than an ISO persona timestamp on the same day', async () => {
      vi.mocked(mockMemoryRepo.findByScopeKind).mockReturnValue([
        makePref('用户希望被称呼为"老大"', '2026-05-19 11:38:22'),
      ]);

      const persona = createEmptyPersona();
      persona.lastUpdated = '2026-05-19T00:00:00.000Z';
      vi.mocked(mockPersonaStore.get).mockReturnValue(persona);

      const result = await distiller.shouldDistill(1);
      expect(result).toBe(true);
    });

    it('counts updated preferences as new changes', async () => {
      vi.mocked(mockMemoryRepo.findByScopeKind).mockReturnValue([
        makePref('用户希望被称呼为Boss', '2026-05-18 09:00:00', '2026-05-19 11:00:00'),
      ]);

      const persona = createEmptyPersona();
      persona.lastUpdated = '2026-05-19T00:00:00.000Z';
      vi.mocked(mockPersonaStore.get).mockReturnValue(persona);

      const result = await distiller.shouldDistill(1);
      expect(result).toBe(true);
    });

    it('respects the configured minimum distillation interval', async () => {
      vi.mocked(mockMemoryRepo.findByScopeKind).mockReturnValue(samplePreferences);
      const persona = createEmptyPersona();
      persona.lastUpdated = new Date().toISOString();
      vi.mocked(mockPersonaStore.get).mockReturnValue(persona);

      const result = await distiller.shouldDistill(1, 24);
      expect(result).toBe(false);
    });

    it('uses constructor defaults for threshold and minimum interval', async () => {
      distiller = new PersonaDistiller(mockLLM, mockMemoryRepo, mockPersonaStore, mockLogger, {
        distillThreshold: 3,
        minDistillIntervalHours: 0,
      });
      vi.mocked(mockMemoryRepo.findByScopeKind).mockReturnValue(samplePreferences);

      const persona = createEmptyPersona();
      persona.lastUpdated = '2026-05-15T10:00:00.000Z';
      vi.mocked(mockPersonaStore.get).mockReturnValue(persona);

      const result = await distiller.shouldDistill();
      expect(result).toBe(true);
    });

    it('returns true when no persona exists (all prefs are new)', async () => {
      vi.mocked(mockMemoryRepo.findByScopeKind).mockReturnValue(samplePreferences);
      vi.mocked(mockPersonaStore.get).mockReturnValue(null);

      const result = await distiller.shouldDistill();
      expect(result).toBe(true);
    });
  });

  // ── Edge cases ──

  describe('edge cases', () => {
    it('handles empty LLM response string', async () => {
      vi.mocked(mockMemoryRepo.findByScopeKind).mockReturnValue(samplePreferences);
      vi.mocked(mockLLM.call).mockResolvedValue('');

      const result = await distiller.distillFull();
      expect(result.version).toBe(1);
    });

    it('handles LLM response with only whitespace', async () => {
      vi.mocked(mockMemoryRepo.findByScopeKind).mockReturnValue(samplePreferences);
      vi.mocked(mockLLM.call).mockResolvedValue('   \n  \n  ');

      const result = await distiller.distillFull();
      expect(result.version).toBe(1);
    });
  });
});
