// ---------------------------------------------------------------------------
// v4 ToolDefinition for the team_delete tool
// ---------------------------------------------------------------------------

import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { textResult, errorResult } from '../../platform/tool-result.js';
import { sharedTeamRunStore } from './shared-stores.js';

export const teamDeleteCapability: ToolCapabilityDescriptor = {
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

const TeamDeleteParams = Type.Object({
  teamId: Type.String(),
});

interface TeamDeleteArgs {
  teamId: string;
}

export function createTeamDeleteToolDefinition(): ToolDefinition {
  return {
    name: 'team_delete',
    label: 'Team Delete',
    description: 'Delete a team run. Only the team owner can delete the team.',
    category: 'task',
    parametersSchema: TeamDeleteParams,
    capability: teamDeleteCapability,
    execute: async (args: TeamDeleteArgs, ctx) => {
      const { teamId } = args;
      const agentId = ctx.agentId ?? 'primary';

      const team = sharedTeamRunStore.get(teamId);
      if (!team) {
        return errorResult(`Team '${teamId}' not found.`);
      }

      if (team.ownerAgentId !== agentId) {
        return errorResult(`Only the team owner (${team.ownerAgentId}) can delete this team. You are '${agentId}'.`);
      }

      const orchestrator = ctx.services.orchestrator;
      if (orchestrator) {
        for (const memberAgentId of team.memberAgentIds) {
          try {
            await orchestrator.stopAgent(memberAgentId);
          } catch {
            // Individual failures don't block others
          }
        }
      }

      sharedTeamRunStore.delete(teamId);
      return textResult(`Team '${teamId}' deleted successfully.`);
    },
  };
}
