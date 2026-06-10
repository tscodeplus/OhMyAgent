// ---------------------------------------------------------------------------
// v4 ToolDefinition for the config tool
// ---------------------------------------------------------------------------

import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import type { AppConfig } from '../../../app/types.js';
import { textResult } from '../../platform/tool-result.js';

export const configCapability: ToolCapabilityDescriptor = {
  category: 'config',
  readOnly: true,
  readsFiles: false,
  writesFiles: false,
  usesShell: false,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'none',
  approvalDefault: 'none',
};

const ConfigParams = Type.Object({
  key: Type.Optional(Type.String()),
});

interface ConfigArgs {
  key?: string;
}

// ---------------------------------------------------------------------------
// Sensitive field detection
// ---------------------------------------------------------------------------

const SENSITIVE_FIELD_NAMES = new Set([
  'apiKey',
  'appSecret',
  'encryptKey',
  'verificationToken',
  'botToken',
  'clientSecret',
  'aesKey',
  'secret',
  'token',
  'password',
  'keyPath',
]);

function isSensitiveField(fieldName: string): boolean {
  return SENSITIVE_FIELD_NAMES.has(fieldName);
}

// ---------------------------------------------------------------------------
// Deep traversal helpers
// ---------------------------------------------------------------------------

type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
interface JsonObject { [key: string]: JsonValue }
type JsonArray = JsonValue[];

/**
 * Walk through an object and replace sensitive fields with `[REDACTED]`.
 */
function redactSensitive(value: JsonValue, depth = 0): JsonValue {
  if (depth > 20) return value;
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((v) => redactSensitive(v, depth + 1));
  }

  const result: JsonObject = {};
  for (const [k, v] of Object.entries(value)) {
    if (isSensitiveField(k)) {
      result[k] = '[REDACTED]';
    } else {
      result[k] = redactSensitive(v, depth + 1);
    }
  }
  return result;
}

/**
 * Resolve a dotted path (e.g. "tools.toolsProfile") inside an object.
 */
function resolvePath(obj: unknown, path: string): { value: JsonValue | undefined; sensitive: boolean } {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return { value: undefined, sensitive: false };
    }
    current = (current as Record<string, unknown>)[part];
  }

  const lastPart = parts[parts.length - 1];
  return {
    value: current as JsonValue,
    sensitive: isSensitiveField(lastPart),
  };
}

/**
 * Build a section summary (list of top-level keys and their types).
 */
function buildSummary(config: AppConfig): string {
  const lines: string[] = ['## Configuration Summary'];

  for (const [key, value] of Object.entries(config)) {
    if (isSensitiveField(key)) {
      lines.push(`- **${key}**: [REDACTED]`);
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const subKeys = Object.keys(value as Record<string, unknown>);
      const visible = subKeys.filter((k) => !isSensitiveField(k));
      const redacted = subKeys.filter((k) => isSensitiveField(k));
      const parts: string[] = [];
      if (visible.length > 0) parts.push(`${visible.length} field(s)`);
      if (redacted.length > 0) parts.push(`${redacted.length} redacted`);
      lines.push(`- **${key}**: { ${parts.join(', ')} }`);
    } else if (Array.isArray(value)) {
      lines.push(`- **${key}**: [${value.length} items]`);
    } else {
      lines.push(`- **${key}**: ${String(value)}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export function createConfigToolDefinition(): ToolDefinition {
  return {
    name: 'config',
    label: 'Config',
    description: 'View app configuration. Returns summary of all sections or a specific key value.',
    category: 'config',
    parametersSchema: ConfigParams,
    capability: configCapability,
    execute: async (args: ConfigArgs, ctx) => {
      const config = ctx.services.config;

      if (!args.key) {
        return textResult(buildSummary(config));
      }

      const { value, sensitive } = resolvePath(config, args.key);

      if (value === undefined) {
        return textResult(`Config key "${args.key}" not found.`);
      }

      if (sensitive) {
        return textResult('[REDACTED]');
      }

      // Always redact before serialization — parent objects may contain
      // sensitive child fields even if the resolved key itself is not sensitive.
      return textResult(JSON.stringify(redactSensitive(value as JsonValue), null, 2));
    },
  };
}
