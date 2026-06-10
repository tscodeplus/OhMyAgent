import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { textResult } from '../../platform/tool-result.js';
import type { MemoryDoctor } from '../../../memory/maintenance/memory-doctor.js';

export const memoryDoctorToolCapability: ToolCapabilityDescriptor = {
  category: 'memory',
  readOnly: true, // readOnly in diagnose mode
  readsFiles: false,
  writesFiles: false,
  usesShell: false,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'none',
  approvalDefault: 'none',
};

const MemoryDoctorParams = Type.Object({
  /** Set to true to execute repairs. Default false (diagnose only). */
  repair: Type.Optional(Type.Boolean()),
});

interface MemoryDoctorArgs {
  repair?: boolean;
}

export function createMemoryDoctorToolDefinition(options: {
  doctor: MemoryDoctor;
}): ToolDefinition<MemoryDoctorArgs> {
  return {
    name: 'memory_doctor',
    label: 'Memory Doctor',
    description: 'Diagnose memory health: orphan data, FTS consistency, persona staleness, missing embeddings.',
    category: 'memory',
    parametersSchema: MemoryDoctorParams,
    capability: memoryDoctorToolCapability,
    execute: async (args) => {
      const report = args.repair
        ? await options.doctor.repair()
        : await options.doctor.diagnose();

      const lines: string[] = [
        '=== Memory Doctor Report ===',
        `Mode: ${args.repair ? 'repair' : 'diagnose'}`,
        `Total Issues: ${report.totalIssues}`,
        `Repaired: ${report.repaired}`,
        '',
      ];

      for (const check of report.checks) {
        const icon = check.status === 'ok' ? '✓' : check.status === 'warning' ? '⚠' : '✗';
        lines.push(`${icon} ${check.name}: ${check.message}`);
      }

      return textResult(lines.join('\n'), {
        totalIssues: report.totalIssues,
        repaired: report.repaired,
        checks: report.checks.map(c => ({ name: c.name, status: c.status })),
      });
    },
  };
}
