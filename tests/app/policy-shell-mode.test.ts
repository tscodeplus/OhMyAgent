// ---------------------------------------------------------------------------
// Tests for the shell exec-mode × global policy-mode interaction.
//
// Shell commands bypass the tool-level gate (policy-center delegates them to
// the shell execution policy), so `policy.mode: safe` must downgrade a
// `trusted` shell exec mode — otherwise trusted auto-approval silently
// bypasses the safe global policy (e.g. `rm` classifies as `unknown` and
// trusted mode approves unknown programs).
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { effectiveShellExecMode } from '../../src/app/composers/policy-services.js';
import { SQLiteApprovalGate } from '../../src/tools/approval-gate.js';
import { ApprovalPolicyRepository } from '../../src/memory/repositories/approval-policy-repository.js';
import { normalizeCommand } from '../../src/tools/shell-command-policy.js';
import { createTestDatabase } from '../e2e/helpers.js';

describe('effectiveShellExecMode', () => {
  it('downgrades trusted to safe when global policy mode is safe', () => {
    expect(effectiveShellExecMode('safe', 'trusted')).toBe('safe');
  });

  it('keeps balanced/safe shell modes unchanged under safe policy mode', () => {
    expect(effectiveShellExecMode('safe', 'balanced')).toBe('balanced');
    expect(effectiveShellExecMode('safe', 'safe')).toBe('safe');
  });

  it('does not touch shell exec mode under other policy modes', () => {
    expect(effectiveShellExecMode('balanced', 'trusted')).toBe('trusted');
    expect(effectiveShellExecMode('bypass', 'trusted')).toBe('trusted');
    expect(effectiveShellExecMode('permissive', 'trusted')).toBe('trusted');
    expect(effectiveShellExecMode(undefined, 'trusted')).toBe('trusted');
  });
});

describe('shell gate under safe global policy', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDatabase();
  });

  afterEach(() => {
    db.close();
  });

  function evaluate(gate: SQLiteApprovalGate, command: string) {
    return gate.evaluate({
      kind: 'shell',
      command: normalizeCommand(command),
      sessionKey: 's1',
      scope: 'session',
      scopeKey: 's1',
      timestamp: Date.now(),
    } as any);
  }

  it('trusted shell mode auto-approves rm (the gap this guards against)', async () => {
    const gate = new SQLiteApprovalGate(new ApprovalPolicyRepository(db), {
      execMode: 'trusted',
    });
    expect(await evaluate(gate, 'rm /tmp/123.456')).toBe('approved');
  });

  it('safe shell mode requires approval for rm', async () => {
    const gate = new SQLiteApprovalGate(new ApprovalPolicyRepository(db), {
      // what effectiveShellExecMode('safe', 'trusted') produces
      execMode: 'safe',
    });
    expect(await evaluate(gate, 'rm /tmp/123.456')).toBe('requires_approval');
  });
});
