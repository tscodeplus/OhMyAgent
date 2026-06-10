// ---------------------------------------------------------------------------
// v4 ToolDefinition for the team_create tool
// ---------------------------------------------------------------------------

import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { textResult, errorResult } from '../../platform/tool-result.js';
import { sharedTeamRunStore } from './shared-stores.js';

export const teamCreateCapability: ToolCapabilityDescriptor = {
  category: 'task',
  readOnly: false,
  readsFiles: false,
  writesFiles: false,
  usesShell: false,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'none',
  approvalDefault: 'mutating',
};

const TeamCreateParams = Type.Object({
  teamName: Type.Optional(Type.String()),
  memberAgentIds: Type.Optional(Type.Array(Type.String())),
});

interface TeamCreateArgs {
  teamName?: string;
  memberAgentIds?: string[];
}

export function createTeamCreateToolDefinition(): ToolDefinition {
  return {
    name: 'team_create',
    label: 'Team Create',
    description: 'Create a team for multi-agent collaboration.',
    category: 'task',
    parametersSchema: TeamCreateParams,
    capability: teamCreateCapability,
    execute: async (args: TeamCreateArgs, ctx) => {
      const randomSuffix = Math.random().toString(36).slice(2, 8);
      const teamId = `team-${Date.now()}-${randomSuffix}`;
      const rootSessionId = ctx.sessionId ?? 'default';
      const ownerAgentId = ctx.agentId ?? 'primary';
      const memberAgentIds = args.memberAgentIds ?? [];

      const team = sharedTeamRunStore.create({
        teamId,
        rootSessionId,
        ownerAgentId,
        memberAgentIds,
      });

      const info = [
        `Team created successfully.`,
        ``,
        `Team ID: ${team.teamId}`,
        `Owner Agent: ${team.ownerAgentId}`,
        `Root Session: ${team.rootSessionId}`,
        `Members: ${team.memberAgentIds.length > 0 ? team.memberAgentIds.join(', ') : '(none)'}`,
        `Status: ${team.status}`,
        `Name: ${args.teamName ?? '(unnamed)'}`,
      ].join('\n');

      return textResult(info, { teamId: team.teamId });
    },
  };
}
