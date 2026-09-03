import { describe, expect, it } from 'vitest';
import { PROFILE_TOOLS } from '../../src/agent/agent-manager';

describe('AgentManager PROFILE_TOOLS', () => {
  it('exposes Phase 6 standard collaboration tools in the standard profile', () => {
    expect(PROFILE_TOOLS.standard).toEqual(
      expect.arrayContaining(['task_create', 'task_get', 'task_list', 'send_message']),
    );
  });

  it('full profile is an empty allowlist (= all tools visible), including orchestration', () => {
    expect(PROFILE_TOOLS.full).toEqual([]);
  });

  it('restricted profile has no shell, no persisting members and no write tools', () => {
    expect(PROFILE_TOOLS.restricted).not.toContain('shell');
    expect(PROFILE_TOOLS.restricted).not.toContain('file_write');
    expect(PROFILE_TOOLS.restricted).not.toContain('file-edit');
    expect(PROFILE_TOOLS.restricted).not.toContain('cronjob');
    expect(PROFILE_TOOLS.restricted).not.toContain('skill_create');
    expect(PROFILE_TOOLS.restricted).not.toContain('skill-lint');
    expect(PROFILE_TOOLS.restricted).toEqual(
      expect.arrayContaining([
        'file_read',
        'memory_recall',
        'memory-recall',
        'memory_store',
        'memory-store',
        'memory_list',
        'session_summarize',
        'tool_search',
        'brief',
        'ask_user_question',
      ]),
    );
  });

  it('does not expose computer_use in the standard profile', () => {
    expect(PROFILE_TOOLS.standard).not.toContain('computer_use');
  });
});
