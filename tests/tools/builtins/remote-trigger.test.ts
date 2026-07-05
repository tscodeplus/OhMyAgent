// ---------------------------------------------------------------------------
// Tests for remote_trigger v4 ToolDefinition
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { createRemoteTriggerToolDefinition } from '../../../src/tools/builtins/web/remote-trigger-definition.js';
import type { ToolExecutionContext } from '../../../src/tools/platform/tool-context.js';
import { extractToolText, expectToolResultContains } from '../../helpers/tool-result.js';

// ---------------------------------------------------------------------------
// Context factory
// ---------------------------------------------------------------------------

function makeCtx(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    cwd: '/tmp',
    policyScope: { agentId: 'test' } as any,
    services: {
      config: {
        remoteTriggers: {
          targets: [
            { id: 'deploy-webhook', name: 'Deploy Webhook', url: 'https://127.0.0.1:19999/deploy', method: 'POST' },
            { id: 'status-update', name: 'Status Update', url: 'https://api.example.com/status', method: 'PUT', headers: { 'X-Api-Key': 'secret123' } },
          ],
        },
      },
    } as any,
    ...overrides,
  };
}

const triggerDef = createRemoteTriggerToolDefinition();

describe('remote_trigger', () => {
  it('has correct capability descriptor', () => {
    expect(triggerDef.capability.category).toBe('web');
    expect(triggerDef.capability.readOnly).toBe(false);
    expect(triggerDef.capability.usesNetwork).toBe(true);
    expect(triggerDef.capability.approvalDefault).toBe('high_risk');
  });

  it('has correct name and description', () => {
    expect(triggerDef.name).toBe('remote_trigger');
    expect(triggerDef.label).toBe('Remote Trigger');
    expect(triggerDef.description).toContain('pre-configured');
  });

  // -----------------------------------------------------------------------
  // Config validation — unknown target
  // -----------------------------------------------------------------------

  it('returns error for unknown target ID', async () => {
    const ctx = makeCtx();
    const result = await triggerDef.execute({ targetId: 'nonexistent' }, ctx);
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'not found');
  });

  it('lists known targets when target is not found', async () => {
    const ctx = makeCtx();
    const result = await triggerDef.execute({ targetId: 'unknown' }, ctx);
    expect(result.isError).toBe(true);
    const text = extractToolText(result);
    expect(text).toContain('deploy-webhook');
    expect(text).toContain('status-update');
  });

  // -----------------------------------------------------------------------
  // URL validation — https enforcement
  // -----------------------------------------------------------------------

  it('rejects targets with non-https URLs that are not localhost', async () => {
    const ctx = makeCtx({
      services: {
        config: {
          remoteTriggers: {
            targets: [
              { id: 'http-endpoint', name: 'HTTP Endpoint', url: 'http://public-api.example.com/action', method: 'POST' },
            ],
          },
        },
      } as any,
    });
    const result = await triggerDef.execute({ targetId: 'http-endpoint' }, ctx);
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'https');
  });

  // -----------------------------------------------------------------------
  // Payload validation
  // -----------------------------------------------------------------------

  it('accepts a payload parameter', async () => {
    const schema = triggerDef.parametersSchema as any;
    expect(schema.properties.payload).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Security: no arbitrary URLs
  // -----------------------------------------------------------------------

  it('never accepts arbitrary URLs — only configured target IDs', async () => {
    const ctx = makeCtx();
    // Even if we fabricate a targetId, it must match the config
    const result = await triggerDef.execute({ targetId: 'http://evil.com/hack' }, ctx);
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'not found');
  });

  it('only allows configured target IDs', async () => {
    const ctx = makeCtx();
    const result = await triggerDef.execute({ targetId: 'deploy-webhook' }, ctx);
    // Should fail with a connection error, not a "not found" error
    expect(result.isError).toBe(true);
    const text = extractToolText(result);
    expect(text).not.toContain('not found');
  });

  // -----------------------------------------------------------------------
  // Empty targets in config
  // -----------------------------------------------------------------------

  it('returns error when no targets are configured', async () => {
    const ctx = makeCtx({
      services: {
        config: {
          remoteTriggers: {},
        },
      } as any,
    });
    const result = await triggerDef.execute({ targetId: 'anything' }, ctx);
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'not found');
  });
});
