import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema';
import { MemoryRepository } from '../../src/memory/repositories/memory-repository';
import { PersonaStore } from '../../src/memory/persona-store';
import { createEmptyPersona } from '../../src/memory/persona-model';
import type { UserPersona } from '../../src/memory/persona-model';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFullPersona(): UserPersona {
  return {
    version: 2,
    lastUpdated: new Date().toISOString(),
    summary: '一位专注 Android 开发的资深工程师，偏好简洁直接的沟通风格。',
    preferences: {
      tools: ['shell', 'file_read', 'file_write'],
      languages: ['zh-CN', 'Python', 'Bash'],
      workflows: ['先读代码再改', '先 git pull 再开始工作'],
      communication: 'concise',
    },
    skills: {
      known: ['Android', 'Python', 'Docker'],
      learning: ['Rust', 'Kubernetes'],
    },
    context: {
      device: 'OnePlus 13 / Termux / WSL2',
      environment: 'Node.js 20, pnpm',
      timezone: 'Asia/Shanghai',
      activeProjects: ['OhMyAgent'],
    },
    stats: {
      totalSessions: 10,
      totalMessages: 200,
      lastActive: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('PersonaStore', () => {
  let db: Database.Database;
  let memoryRepo: MemoryRepository;
  let store: PersonaStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db);
    memoryRepo = new MemoryRepository(db);
    store = new PersonaStore(memoryRepo);
  });

  afterEach(() => {
    db.close();
  });

  // -----------------------------------------------------------------------
  // get()
  // -----------------------------------------------------------------------

  describe('get()', () => {
    it('returns null when no persona exists', () => {
      expect(store.get()).toBeNull();
    });

    it('returns persona after save — round-trip field consistency', () => {
      const persona = makeFullPersona();
      store.save(persona);

      const result = store.get();
      expect(result).not.toBeNull();
      expect(result!.version).toBe(persona.version);
      expect(result!.summary).toBe(persona.summary);
      expect(result!.preferences.tools).toEqual(persona.preferences.tools);
      expect(result!.preferences.languages).toEqual(persona.preferences.languages);
      expect(result!.preferences.workflows).toEqual(persona.preferences.workflows);
      expect(result!.preferences.communication).toBe(persona.preferences.communication);
      expect(result!.skills.known).toEqual(persona.skills.known);
      expect(result!.skills.learning).toEqual(persona.skills.learning);
      expect(result!.context.device).toBe(persona.context.device);
      expect(result!.context.environment).toBe(persona.context.environment);
      expect(result!.context.timezone).toBe(persona.context.timezone);
      expect(result!.context.activeProjects).toEqual(persona.context.activeProjects);
      expect(result!.stats.totalSessions).toBe(persona.stats.totalSessions);
      expect(result!.stats.totalMessages).toBe(persona.stats.totalMessages);
    });

    it('returns the latest version after multiple saves', () => {
      const p1 = createEmptyPersona();
      p1.summary = 'Version 1';
      store.save(p1);

      const p2 = createEmptyPersona();
      p2.summary = 'Version 2';
      store.save(p2);

      const result = store.get();
      expect(result).not.toBeNull();
      expect(result!.summary).toBe('Version 2');
    });
  });

  // -----------------------------------------------------------------------
  // save()
  // -----------------------------------------------------------------------

  describe('save()', () => {
    it('persists persona to the memories table with correct storage fields', () => {
      const persona = makeFullPersona();
      store.save(persona);

      const memory = memoryRepo.findById('__persona__');
      expect(memory).toBeDefined();
      expect(memory!.id).toBe('__persona__');
      expect(memory!.scope).toBe('user');
      expect(memory!.scope_key).toBe('__persona__');
      expect(memory!.kind).toBe('persona');
      expect(memory!.visibility).toBe('shared');
      expect(memory!.agent_id).toBeNull();

      // Content must be valid JSON matching the saved persona
      const parsed = JSON.parse(memory!.content);
      expect(parsed.summary).toBe(persona.summary);
      expect(parsed.preferences.tools).toEqual(persona.preferences.tools);
    });

    it('updates lastUpdated on each save', () => {
      const persona = createEmptyPersona();
      const beforeSave = new Date(persona.lastUpdated).getTime();

      // Wait a few ms so the new timestamp differs
      store.save(persona);

      const afterSave = new Date(persona.lastUpdated).getTime();
      expect(afterSave).toBeGreaterThanOrEqual(beforeSave);
    });

    it('does not create duplicate records on repeated saves', () => {
      const persona = makeFullPersona();
      store.save(persona);
      store.save(persona);
      store.save(persona);

      // Only one row should exist
      const all = memoryRepo.findByScopeAndKind('user', '__persona__', 'persona');
      expect(all).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // exists()
  // -----------------------------------------------------------------------

  describe('exists()', () => {
    it('returns false when no persona has been stored', () => {
      expect(store.exists()).toBe(false);
    });

    it('returns true after a persona is saved', () => {
      store.save(makeFullPersona());
      expect(store.exists()).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // toContextString()
  // -----------------------------------------------------------------------

  describe('toContextString()', () => {
    it('returns a non-empty Chinese string under 500 characters', () => {
      store.save(makeFullPersona());

      const result = store.toContextString();
      expect(result).toBeTruthy();
      expect(result.length).toBeGreaterThan(0);
      expect(result.length).toBeLessThanOrEqual(500);
      expect(result).toContain('用户画像');
    });

    it('contains key persona information (tools, languages, skills)', () => {
      store.save(makeFullPersona());

      const result = store.toContextString();
      expect(result).toContain('shell');
      expect(result).toContain('zh-CN');
      expect(result).toContain('Android');
      expect(result).toContain('OnePlus');
      expect(result).toContain('工作流');
      expect(result).toContain('Docker');
    });

    it('returns empty string for an empty persona (createEmptyPersona)', () => {
      store.save(createEmptyPersona());

      const result = store.toContextString();
      expect(result).toBe('');
    });

    it('returns empty string when no persona is stored', () => {
      const result = store.toContextString();
      expect(result).toBe('');
    });

    it('injects preferences newer than the stored persona as a priority overlay', () => {
      const persona = makeFullPersona();
      store.save(persona);
      const saved = store.get()!;

      const oldPref = memoryRepo.create({
        id: 'old-pref',
        scope: 'user',
        scope_key: '',
        kind: 'preference',
        content: '用户希望被称呼为老板',
      });
      db.prepare('UPDATE memories SET created_at = ? WHERE id = ?')
        .run('2000-01-01 00:00:00', oldPref.id);

      const newPref = memoryRepo.create({
        id: 'new-pref',
        scope: 'user',
        scope_key: '',
        kind: 'preference',
        content: '用户希望被称呼为老大',
      });
      const newerThanPersona = new Date(new Date(saved.lastUpdated).getTime() + 1000)
        .toISOString()
        .slice(0, 19)
        .replace('T', ' ');
      db.prepare('UPDATE memories SET created_at = ? WHERE id = ?')
        .run(newerThanPersona, newPref.id);

      const result = store.toContextString();

      expect(result).toContain('[最新用户偏好，优先于用户画像]');
      expect(result).toContain('用户希望被称呼为老大');
      expect(result).not.toContain('用户希望被称呼为老板');
      expect(result.indexOf('[最新用户偏好，优先于用户画像]')).toBeLessThan(result.indexOf(persona.summary));
    });

    it('injects preferences updated after the stored persona as a priority overlay', () => {
      const persona = makeFullPersona();
      store.save(persona);
      const saved = store.get()!;

      const updatedPref = memoryRepo.create({
        id: 'updated-pref',
        scope: 'user',
        scope_key: '',
        kind: 'preference',
        content: '用户希望被称呼为Boss',
      });
      const beforePersona = new Date(new Date(saved.lastUpdated).getTime() - 10_000)
        .toISOString()
        .slice(0, 19)
        .replace('T', ' ');
      const afterPersona = new Date(new Date(saved.lastUpdated).getTime() + 10_000)
        .toISOString()
        .slice(0, 19)
        .replace('T', ' ');
      db.prepare('UPDATE memories SET created_at = ?, updated_at = ? WHERE id = ?')
        .run(beforePersona, afterPersona, updatedPref.id);

      const result = store.toContextString();

      expect(result).toContain('[最新用户偏好，优先于用户画像]');
      expect(result).toContain('用户希望被称呼为Boss');
    });

    it('can return a latest-preference overlay even when no persona exists', () => {
      memoryRepo.create({
        id: 'new-pref',
        scope: 'user',
        scope_key: '',
        kind: 'preference',
        content: '用户希望被称呼为老大',
      });

      const result = store.toContextString();

      expect(result).toContain('[当前用户画像');
      expect(result).toContain('[最新用户偏好，优先于用户画像]');
      expect(result).toContain('用户希望被称呼为老大');
    });
  });

  describe('applyFastPreference()', () => {
    it('updates persona immediately for preferred-name memories', () => {
      const original = makeFullPersona();
      original.lastUpdated = '2026-05-20T00:00:00.000Z';
      store.save(original, { updateLastUpdated: false });

      const updated = store.applyFastPreference('用户希望被称呼为"老大"');

      expect(updated).toBe(true);
      const persona = store.get()!;
      expect(persona.summary).toContain('用户希望被称呼为老大');
      expect(persona.preferences.communication).toContain('称呼用户为老大');
      expect(persona.lastUpdated).toBe('2026-05-20T00:00:00.000Z');
    });

    it('does not advance the distillation watermark when creating persona from the first fast preference', () => {
      memoryRepo.create({
        id: 'new-pref',
        scope: 'user',
        scope_key: '',
        kind: 'preference',
        content: '用户希望被称呼为Boss',
      });

      const updated = store.applyFastPreference('用户希望被称呼为Boss');

      expect(updated).toBe(true);
      expect(store.get()!.lastUpdated).toBe('1970-01-01T00:00:00.000Z');
      expect(store.toContextString()).toContain('用户希望被称呼为Boss');
    });

    it('replaces the previous preferred-name communication rule', () => {
      const persona = makeFullPersona();
      persona.preferences.communication = '称呼用户为老大；回复直接';
      store.save(persona);

      const updated = store.applyFastPreference('用户希望被称呼为"大拿"');

      expect(updated).toBe(true);
      const communication = store.get()!.preferences.communication;
      expect(communication).toContain('称呼用户为大拿');
      expect(communication).not.toContain('称呼用户为老大');
      expect(communication).toContain('回复直接');
    });

    it('removes stale preferred-name clauses from summary and communication', () => {
      const persona = makeFullPersona();
      persona.summary = '用户希望被称呼为大Boss。用户偏好简洁直接的交流方式，称呼为“大Boss”。热爱乒乓球。';
      persona.preferences.communication = '称呼用户为大Boss；简洁、回应较少，称呼为大Boss';
      store.save(persona);

      const updated = store.applyFastPreference('用户希望被称呼为"老板"');

      expect(updated).toBe(true);
      const next = store.get()!;
      expect(next.summary).toContain('用户希望被称呼为老板');
      expect(next.summary).not.toContain('大Boss');
      expect(next.preferences.communication).toContain('称呼用户为老板');
      expect(next.preferences.communication).not.toContain('大Boss');
    });

    it('parses explicit preferred-name wording without capturing label words', () => {
      store.save(makeFullPersona());

      const updated = store.applyFastPreference('用户的称呼偏好为"Boss"');

      expect(updated).toBe(true);
      const persona = store.get()!;
      expect(persona.summary).toContain('用户希望被称呼为Boss');
      expect(persona.summary).not.toContain('偏好为');
      expect(persona.preferences.communication).toContain('称呼用户为Boss');
    });

    it('returns false for unrelated preferences', () => {
      store.save(makeFullPersona());

      const updated = store.applyFastPreference('用户喜欢使用 pnpm');

      expect(updated).toBe(false);
      expect(store.get()!.preferences.communication).toBe('concise');
    });
  });
});
