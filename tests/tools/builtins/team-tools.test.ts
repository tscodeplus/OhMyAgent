// ---------------------------------------------------------------------------
// Tests for team_create and team_delete tool definitions
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from 'vitest';
import { createTeamCreateToolDefinition } from '../../../src/tools/builtins/tasks/team-create-definition.js';
import { createTeamDeleteToolDefinition } from '../../../src/tools/builtins/tasks/team-delete-definition.js';
import { sharedTeamRunStore } from '../../../src/tools/builtins/tasks/shared-stores.js';
import type { ToolExecutionContext } from '../../../src/tools/platform/tool-context.js';
import { extractToolText, expectToolResultContains } from '../../helpers/tool-result.js';
import type { Orchestrator } from '../../../src/orchestrator/types.js';

const teamCreateDef = createTeamCreateToolDefinition();
const teamDeleteDef = createTeamDeleteToolDefinition();

function minimalCtx(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    cwd: '/tmp',
    sessionId: 'test-session',
    agentId: 'agent-1',
    policyScope: { agentId: 'agent-1' } as any,
    services: {} as any,
    ...overrides,
  };
}

describe('team_create', () => {
  beforeEach(() => {
    sharedTeamRunStore.clear();
  });

  it('creates a team and returns team info', async () => {
    const result = await teamCreateDef.execute({}, minimalCtx());
    expect(result.isError).toBeFalsy();
    const text = extractToolText(result);
    expect(text).toContain('Team created successfully');
    expect(text).toContain('Team ID: team-');
    expect(text).toContain('Owner Agent: agent-1');
    expect(text).toContain('Root Session: test-session');
    expect(result.metadata?.teamId).toBeDefined();
  });

  it('creates a team with member agent IDs', async () => {
    const result = await teamCreateDef.execute(
      { memberAgentIds: ['member-1', 'member-2'] },
      minimalCtx(),
    );
    expect(result.isError).toBeFalsy();
    const text = extractToolText(result);
    expect(text).toContain('member-1, member-2');
  });

  it('creates a team with a custom name', async () => {
    const result = await teamCreateDef.execute(
      { teamName: 'My Test Team' },
      minimalCtx(),
    );
    expect(result.isError).toBeFalsy();
    const text = extractToolText(result);
    expect(text).toContain('My Test Team');
  });

  it('stores the team in the shared store', async () => {
    const result = await teamCreateDef.execute({}, minimalCtx());
    const teamId = result.metadata?.teamId as string;
    const team = sharedTeamRunStore.get(teamId);
    expect(team).toBeDefined();
    expect(team!.ownerAgentId).toBe('agent-1');
    expect(team!.status).toBe('active');
  });
});

describe('team_delete', () => {
  beforeEach(() => {
    sharedTeamRunStore.clear();
  });

  it('deletes a team owned by the calling agent', async () => {
    const createResult = await teamCreateDef.execute({}, minimalCtx({ agentId: 'agent-1' }));
    const teamId = createResult.metadata?.teamId as string;

    const result = await teamDeleteDef.execute({ teamId }, minimalCtx({ agentId: 'agent-1' }));
    expect(result.isError).toBeFalsy();
    expectToolResultContains(result, 'deleted successfully');
    expect(sharedTeamRunStore.get(teamId)).toBeUndefined();
  });

  it('stops team member agents before deleting when orchestrator is available', async () => {
    const stopped: string[] = [];
    const orchestrator = {
      stopAgent: async (agentId: string) => { stopped.push(agentId); },
    } as Partial<Orchestrator> as Orchestrator;
    const createResult = await teamCreateDef.execute(
      { memberAgentIds: ['member-1', 'member-2'] },
      minimalCtx({ agentId: 'agent-1' }),
    );
    const teamId = createResult.metadata?.teamId as string;

    const result = await teamDeleteDef.execute(
      { teamId },
      minimalCtx({ agentId: 'agent-1', services: { orchestrator } as any }),
    );

    expect(result.isError).toBeFalsy();
    expect(stopped).toEqual(['member-1', 'member-2']);
    expect(sharedTeamRunStore.get(teamId)).toBeUndefined();
  });

  it('refuses to delete a non-existent team', async () => {
    const result = await teamDeleteDef.execute(
      { teamId: 'team-nonexistent' },
      minimalCtx(),
    );
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'not found');
  });

  it('refuses to delete a team owned by another agent', async () => {
    const createResult = await teamCreateDef.execute({}, minimalCtx({ agentId: 'agent-owner' }));
    const teamId = createResult.metadata?.teamId as string;

    const result = await teamDeleteDef.execute(
      { teamId },
      minimalCtx({ agentId: 'agent-impostor' }),
    );
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'Only the team owner');
    expect(sharedTeamRunStore.get(teamId)).toBeDefined();
  });
});
