import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { textResult, errorResult } from '../../platform/tool-result.js';
import type { PersonaDistiller } from '../../../memory/persona-distiller.js';

export const personaRebuildToolCapability: ToolCapabilityDescriptor = {
  category: 'memory',
  readOnly: false,
  readsFiles: false,
  writesFiles: false,
  usesShell: false,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'none',
  approvalDefault: 'none',
};

const PersonaRebuildParams = Type.Object({});

interface PersonaRebuildArgs {}

export function createPersonaRebuildToolDefinition(options: {
  personaDistiller: PersonaDistiller;
}): ToolDefinition<PersonaRebuildArgs> {
  return {
    name: 'memory_rebuild_persona',
    label: 'Memory Rebuild Persona',
    description: 'Trigger persona rebuild from all active preference memories.',
    category: 'memory',
    parametersSchema: PersonaRebuildParams,
    capability: personaRebuildToolCapability,
    execute: async () => {
      try {
        const success = await options.personaDistiller.rebuildFull();
        if (success) {
          return textResult('Persona rebuilt successfully from active preferences.');
        }
        return errorResult('Persona rebuild failed — LLM returned invalid response. Existing persona preserved.');
      } catch (err) {
        return errorResult(`Persona rebuild error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
