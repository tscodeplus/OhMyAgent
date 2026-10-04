// ---------------------------------------------------------------------------
// MCP server-level `trust` override (§8.1)
// ---------------------------------------------------------------------------
//
// `trust` exists for servers that never annotate their tools, where the
// capability ladder can only ever say `mutating`. It must not become a way for
// a server to talk its way out of approval hints it *did* declare, so the
// precedence — annotations win whenever they exist — is what these tests pin.

import { describe, expect, it } from 'vitest';

import { capabilityFromAnnotations } from '../../src/mcp/capability.js';
import type { McpStdioServerConfig, McpTrustLevel } from '../../src/mcp/types.js';

function stdioServer(trust?: McpTrustLevel): McpStdioServerConfig {
  return {
    name: 'filesystem',
    enabled: true,
    exposure: 'deferred',
    toolExposure: {},
    toolEnabled: {},
    description: '',
    transport: 'stdio',
    command: 'npx',
    args: [],
    env: {},
    cwd: '',
    ...(trust !== undefined ? { trust } : {}),
  };
}

describe('capabilityFromAnnotations — trust override', () => {
  it('applies trust to a tool that declares no annotations', () => {
    expect(capabilityFromAnnotations(undefined, stdioServer('read_only'))).toMatchObject({
      readOnly: true,
      approvalDefault: 'none',
    });
    expect(capabilityFromAnnotations(undefined, stdioServer('normal'))).toMatchObject({
      readOnly: false,
      approvalDefault: 'mutating',
    });
    expect(capabilityFromAnnotations(undefined, stdioServer('high_risk'))).toMatchObject({
      readOnly: false,
      approvalDefault: 'high_risk',
    });
  });

  it('is a no-op without the key', () => {
    expect(capabilityFromAnnotations(undefined, stdioServer())).toMatchObject({
      readOnly: false,
      approvalDefault: 'mutating',
    });
  });

  it('treats an empty annotations object as "no annotations"', () => {
    expect(capabilityFromAnnotations({}, stdioServer('read_only')).approvalDefault).toBe('none');
  });

  it('never overrides a tool that declares annotations', () => {
    expect(
      capabilityFromAnnotations({ readOnlyHint: true }, stdioServer('high_risk')),
    ).toMatchObject({ readOnly: true, approvalDefault: 'none' });
    expect(
      capabilityFromAnnotations({ destructiveHint: true }, stdioServer('read_only')),
    ).toMatchObject({ readOnly: false, approvalDefault: 'high_risk' });
    // An explicit "not read-only" is still a declaration, so `trust` stays out.
    expect(
      capabilityFromAnnotations({ readOnlyHint: false }, stdioServer('read_only')),
    ).toMatchObject({ readOnly: false, approvalDefault: 'mutating' });
  });

  it('keeps the rest of the descriptor independent of trust', () => {
    expect(capabilityFromAnnotations(undefined, stdioServer('high_risk'))).toMatchObject({
      category: 'mcp',
      pathAccess: 'none',
      usesNetwork: false,
      usesShell: false,
    });
  });
});
