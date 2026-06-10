// ---------------------------------------------------------------------------
// TeamRunStore interface + InMemoryTeamRunStore
// ---------------------------------------------------------------------------

import type { TeamRun } from './types.js';

export interface TeamRunStore {
  create(input: { teamId: string; rootSessionId: string; ownerAgentId: string; memberAgentIds: string[] }): TeamRun;
  get(teamId: string): TeamRun | undefined;
  listBySession(sessionId: string): TeamRun[];
  delete(teamId: string): boolean;
  addMember(teamId: string, agentId: string): TeamRun | undefined;
  removeMember(teamId: string, agentId: string): TeamRun | undefined;
  clear(): void;
}

export class InMemoryTeamRunStore implements TeamRunStore {
  private teams = new Map<string, TeamRun>();

  create(input: { teamId: string; rootSessionId: string; ownerAgentId: string; memberAgentIds: string[] }): TeamRun {
    const team: TeamRun = {
      teamId: input.teamId,
      rootSessionId: input.rootSessionId,
      ownerAgentId: input.ownerAgentId,
      memberAgentIds: input.memberAgentIds,
      createdAt: Date.now(),
      status: 'active',
    };
    this.teams.set(team.teamId, team);
    return team;
  }

  get(teamId: string): TeamRun | undefined {
    return this.teams.get(teamId);
  }

  listBySession(sessionId: string): TeamRun[] {
    return [...this.teams.values()].filter(t => t.rootSessionId === sessionId);
  }

  delete(teamId: string): boolean {
    return this.teams.delete(teamId);
  }

  addMember(teamId: string, agentId: string): TeamRun | undefined {
    const team = this.teams.get(teamId);
    if (!team || team.status !== 'active') return undefined;
    if (!team.memberAgentIds.includes(agentId)) {
      team.memberAgentIds = [...team.memberAgentIds, agentId];
    }
    return team;
  }

  removeMember(teamId: string, agentId: string): TeamRun | undefined {
    const team = this.teams.get(teamId);
    if (!team) return undefined;
    team.memberAgentIds = team.memberAgentIds.filter(id => id !== agentId);
    return team;
  }

  clear(): void {
    this.teams.clear();
  }
}
