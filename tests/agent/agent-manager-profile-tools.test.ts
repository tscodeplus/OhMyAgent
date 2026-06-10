import { describe, expect, it } from 'vitest';
import { PROFILE_TOOLS } from '../../src/agent/agent-manager';

describe('AgentManager PROFILE_TOOLS', () => {
  it('exposes Phase 6 standard collaboration tools in the standard profile', () => {
    expect(PROFILE_TOOLS.standard).toEqual(expect.arrayContaining([
      'task_create',
      'task_get',
      'task_list',
      'send_message',
    ]));
  });

  it('exposes Phase 6 orchestration and environment tools in the advanced profile', () => {
    expect(PROFILE_TOOLS.advanced).toEqual(expect.arrayContaining([
      'spawn_agent',
      'task_create',
      'task_get',
      'task_list',
      'send_message',
      'task_stop',
      'task_output',
      'task_update',
      'team_create',
      'team_delete',
      'enter_plan_mode',
      'exit_plan_mode',
      'enter_worktree',
      'exit_worktree',
    ]));
  });

  it('does not expose computer_use in the standard profile', () => {
    expect(PROFILE_TOOLS.standard).not.toContain('computer_use');
  });
});
