import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { textResult } from '../../platform/tool-result.js';
import type { PersonaAuditService } from '../../../memory/persona/persona-audit-service.js';

export const personaAuditToolCapability: ToolCapabilityDescriptor = {
  category: 'memory',
  readOnly: true,
  readsFiles: false,
  writesFiles: false,
  usesShell: false,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'none',
  approvalDefault: 'none',
};

const PersonaAuditParams = Type.Object({});

interface PersonaAuditArgs {}

export function createPersonaAuditToolDefinition(options: {
  auditService: PersonaAuditService;
}): ToolDefinition<PersonaAuditArgs> {
  return {
    name: 'memory_audit_persona',
    label: 'Memory Audit Persona',
    description: 'Audit user persona: active/superseded preferences, derived fields, distillation status.',
    category: 'memory',
    parametersSchema: PersonaAuditParams,
    capability: personaAuditToolCapability,
    execute: async () => {
      const audit = options.auditService.audit();

      const lines: string[] = [];
      lines.push('=== Persona Audit ===');
      lines.push('');
      lines.push(`Has Persona: ${audit.hasPersona}`);
      lines.push(`Persona Updated: ${audit.personaUpdatedAt ?? 'never'}`);
      lines.push('');

      // Last distillation
      lines.push('--- Last Distillation ---');
      lines.push(`Mode: ${audit.lastDistillation.mode ?? 'none'}`);
      lines.push(`Status: ${audit.lastDistillation.status ?? 'none'}`);
      lines.push(`Timestamp: ${audit.lastDistillation.timestamp ?? 'none'}`);
      if (audit.lastDistillation.error) {
        lines.push(`Error: ${audit.lastDistillation.error}`);
      }
      lines.push('');

      // Active preferences
      lines.push(`--- Active Preferences (${audit.activePreferences.length}) ---`);
      for (const pref of audit.activePreferences.slice(0, 20)) {
        const src = pref.sourceChannel ? ` [${pref.sourceChannel}]` : '';
        lines.push(`- [${pref.topic}] ${pref.content.slice(0, 100)}${src}`);
      }
      lines.push('');

      // Superseded preferences
      if (audit.supersededPreferences.length > 0) {
        lines.push(`--- Superseded Preferences (${audit.supersededPreferences.length}) ---`);
        for (const pref of audit.supersededPreferences.slice(0, 10)) {
          const by = pref.supersededBy ? ` (superseded by ${pref.supersededBy})` : '';
          lines.push(`- ${pref.content.slice(0, 100)}${by}`);
        }
        lines.push('');
      }

      // Derived fields
      if (audit.derivedFields.length > 0) {
        lines.push(`--- Derived Fields (${audit.derivedFields.length}) ---`);
        for (const field of audit.derivedFields) {
          lines.push(`- ${field.field}: ${field.value} (confidence: ${field.confidence}, evidence: ${field.evidenceIds.length} preferences)`);
        }
      }

      return textResult(lines.join('\n'), {
        activeCount: audit.activePreferences.length,
        supersededCount: audit.supersededPreferences.length,
        hasPersona: audit.hasPersona,
      });
    },
  };
}
