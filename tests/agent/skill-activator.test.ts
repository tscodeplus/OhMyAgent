/**
 * Skill approval-override registration and skill tool policy recording.
 *
 * Regression tests for the two defects in activateSkill():
 *  - re-activating a skill INSERTed the same deterministic policy id again and
 *    the SQLITE_CONSTRAINT_UNIQUE throw escaped into the agent turn;
 *  - scopeKey: '' is a wildcard for ApprovalGate.scopeMatches(), so a skill's
 *    `allow` override approved every skill-activated session forever.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema';
import { ApprovalPolicyRepository } from '../../src/memory/repositories/approval-policy-repository';
import { SQLiteApprovalGate } from '../../src/tools/approval-gate';
import { normalizeCommand } from '../../src/tools/shell-command-policy';
import { activateSkill, getSkillToolPolicy } from '../../src/agent/skill-activator';
import { compileSkillContext } from '../../src/skills/skill-compiler';
import type { LoadedSkill } from '../../src/skills/skill-loader';
import type { ResolvedSkill } from '../../src/skills/skill-router';
import type { SkillRegistry } from '../../src/skills/skill-registry';
import type { ApprovalOverride } from '../../src/app/types';

let db: Database.Database;
let policyRepo: ApprovalPolicyRepository;
let gate: SQLiteApprovalGate;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  policyRepo = new ApprovalPolicyRepository(db);
  gate = new SQLiteApprovalGate(policyRepo);
});

afterEach(() => {
  db.close();
});

function makeSkill(
  id: string,
  options: {
    approvalOverrides?: ApprovalOverride[];
    allowedTools?: string[];
    deniedTools?: string[];
  } = {},
): LoadedSkill {
  return {
    manifest: {
      id,
      name: `${id} skill`,
      description: 'test skill',
      triggers: [id],
      priority: 0,
      enabled: true,
    },
    promptContent: '',
    tools: {
      allowedTools: options.allowedTools ?? [],
      ...(options.deniedTools ? { deniedTools: options.deniedTools } : {}),
    },
    memoryPolicy: { scopes: [] },
    approvalOverrides: options.approvalOverrides,
    path: `/tmp/skills/${id}`,
  } as unknown as LoadedSkill;
}

function makeRegistry(skill: LoadedSkill): SkillRegistry {
  return {
    isLoaded: () => true,
    resolve: () => [
      { skill, matchType: 'trigger', matchedTrigger: skill.manifest.id } as ResolvedSkill,
    ],
    // Real compiler — the test must cover the actual compiled context shape.
    compile: (resolved) => compileSkillContext(resolved),
    getSkills: () => [skill],
    getSkillById: (id: string) => (id === skill.manifest.id ? skill : undefined),
  } as unknown as SkillRegistry;
}

const ADB_ALLOW: ApprovalOverride = {
  targetKind: 'shell',
  patternType: 'exact',
  pattern: 'adb devices',
  effect: 'allow',
};

function skillPolicies() {
  return policyRepo
    .findByTargetKind('shell')
    .filter((p) => p.source === 'skill' && p.pattern === ADB_ALLOW.pattern);
}

describe('activateSkill — approval override registration', () => {
  it('activating the same skill twice does not throw', () => {
    const skill = makeSkill('twice-activation', { approvalOverrides: [ADB_ALLOW] });
    const registry = makeRegistry(skill);

    expect(() => activateSkill('twice-activation go', 'session-1', {
      skillRegistry: registry,
      approvalGate: gate,
    })).not.toThrow();
    expect(() => activateSkill('twice-activation go again', 'session-1', {
      skillRegistry: registry,
      approvalGate: gate,
    })).not.toThrow();

    // Idempotent: the deterministic id is upserted, never duplicated.
    expect(skillPolicies()).toHaveLength(1);
  });

  it('binds the override to the activating skill instead of a wildcard scope key', async () => {
    const skill = makeSkill('scoped-skill', { approvalOverrides: [ADB_ALLOW] });
    const registry = makeRegistry(skill);
    const result = activateSkill('scoped-skill go', 'session-1', {
      skillRegistry: registry,
      approvalGate: gate,
    });

    expect(result.scope).toEqual({ scope: 'skill', scopeKey: 'scoped-skill' });
    const [policy] = skillPolicies();
    expect(policy.scope).toBe('skill');
    expect(policy.scope_key).toBe('scoped-skill');

    const request = (scopeKey: string) => ({
      kind: 'shell' as const,
      command: normalizeCommand('adb devices'),
      sessionKey: 'session-1',
      scope: 'skill' as const,
      scopeKey,
    });

    // The owning skill gets the override...
    await expect(gate.evaluate(request('scoped-skill'))).resolves.toBe('approved');
    // ...but no other activated skill inherits it (empty scope key used to match all).
    await expect(gate.evaluate(request('some-other-skill'))).resolves.toBe('requires_approval');
    // ...and it never applies outside skill scope.
    await expect(
      gate.evaluate({ ...request('scoped-skill'), scope: 'global', scopeKey: '' }),
    ).resolves.toBe('requires_approval');
  });

  it('keeps overrides of different skills in separate rows', () => {
    const override: ApprovalOverride = { ...ADB_ALLOW, pattern: 'adb shell getprop' };
    const a = makeSkill('skill-a-shared-pattern', { approvalOverrides: [ADB_ALLOW, override] });
    const b = makeSkill('skill-b-shared-pattern', { approvalOverrides: [ADB_ALLOW] });

    activateSkill('skill-a-shared-pattern go', 'session-1', {
      skillRegistry: makeRegistry(a),
      approvalGate: gate,
    });
    activateSkill('skill-b-shared-pattern go', 'session-2', {
      skillRegistry: makeRegistry(b),
      approvalGate: gate,
    });

    const rows = policyRepo
      .findByTargetKind('shell')
      .filter((p) => p.source === 'skill')
      .map((p) => p.id)
      .sort();
    expect(rows).toEqual([
      'skill-skill-a-shared-pattern-shell:exact:adb devices',
      'skill-skill-a-shared-pattern-shell:exact:adb shell getprop',
      'skill-skill-b-shared-pattern-shell:exact:adb devices',
    ]);
  });
});

describe('activateSkill — compiled tool policy', () => {
  it('records the compiled allow/deny lists for the activated skill scope', () => {
    const skill = makeSkill('deny-shell-skill', {
      allowedTools: ['web_search'],
      deniedTools: ['shell'],
    });
    activateSkill('deny-shell-skill go', 'session-1', {
      skillRegistry: makeRegistry(skill),
      approvalGate: gate,
    });

    expect(getSkillToolPolicy({ scope: 'skill', scopeKey: 'deny-shell-skill' })).toEqual({
      allowedTools: ['web_search'],
      deniedTools: ['shell'],
    });
  });

  it('returns no skill policy for a global (skill-less) scope', () => {
    expect(getSkillToolPolicy({ scope: 'global', scopeKey: '' })).toBeUndefined();
    expect(getSkillToolPolicy({ scope: 'skill', scopeKey: 'never-activated-skill' })).toBeUndefined();
  });
});
