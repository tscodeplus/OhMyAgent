// ---------------------------------------------------------------------------
// MCP tool visibility across tool profiles (§12.3)
// ---------------------------------------------------------------------------
//
// The predicate is the single place `allow_servers` / `deny_servers` is
// enforced, and the names it compares come from two different spellings: the
// raw `config.yaml` name and the sanitised `mcp__<server>__<tool>` segment
// (`createMcpToolName()` replaces every non-`[A-Za-z0-9_]` character, so
// `my-server` becomes `my_server`). These tests pin the canonicalisation that
// makes the two meet, plus the reserved `resources` pseudo-server and the
// false/undefined split for malformed tool names.

import { describe, expect, it } from 'vitest';

import {
  MCP_RESERVED_SERVER,
  canonicalMcpServerName,
  isMcpToolName,
  isMcpToolVisible,
  serverNameOfMcpTool,
  toMcpVisibilityScope,
} from '../../src/policy/mcp-visibility.js';

describe('canonicalMcpServerName', () => {
  it('treats "-" and "_" as the same separator', () => {
    expect(canonicalMcpServerName('my-server')).toBe('my_server');
    expect(canonicalMcpServerName('my_server')).toBe('my_server');
    expect(canonicalMcpServerName('a-b-c')).toBe('a_b_c');
  });
});

describe('serverNameOfMcpTool', () => {
  it('extracts the sanitised server segment', () => {
    expect(serverNameOfMcpTool('mcp__my_server__read_file')).toBe('my_server');
    expect(serverNameOfMcpTool('read_file')).toBeNull();
    expect(serverNameOfMcpTool('mcp__x')).toBeNull();
    expect(serverNameOfMcpTool('mcp__x__')).toBeNull();
  });

  it('agrees with the prefix predicate', () => {
    expect(isMcpToolName('mcp__a__b')).toBe(true);
    expect(isMcpToolName('read_file')).toBe(false);
  });
});

describe('toMcpVisibilityScope', () => {
  it('canonicalises both lists', () => {
    const scope = toMcpVisibilityScope('standard', {
      allowServers: ['my-server'],
      denyServers: ['legacy-server'],
    });

    expect(scope.allowServers).toEqual(['my_server']);
    expect(scope.denyServers).toEqual(['legacy_server']);
  });

  it('maps an absent config to empty lists', () => {
    expect(toMcpVisibilityScope('standard', undefined).denyServers).toEqual([]);
    expect(toMcpVisibilityScope('standard', null).allowServers).toEqual([]);
  });
});

describe('isMcpToolVisible — allow/deny lists', () => {
  it('blocks a hyphenated server named in deny_servers', () => {
    const scope = toMcpVisibilityScope('standard', { denyServers: ['my-server'] });

    expect(isMcpToolVisible('mcp__my_server__read_file', scope)).toBe(false);
  });

  it('blocks a hyphenated server in the `full` profile too', () => {
    // `full` sees everything by default, so this is where an ineffective
    // deny_servers entry is most visible.
    const scope = toMcpVisibilityScope('full', { denyServers: ['my-server'] });

    expect(isMcpToolVisible('mcp__my_server__read_file', scope)).toBe(false);
  });

  it('matches whichever spelling the config uses', () => {
    expect(
      isMcpToolVisible(
        'mcp__my_server__read_file',
        toMcpVisibilityScope('standard', { denyServers: ['my_server'] }),
      ),
    ).toBe(false);
  });

  it('allows only the listed server when allow_servers is set', () => {
    const scope = toMcpVisibilityScope('standard', { allowServers: ['my-server'] });

    expect(isMcpToolVisible('mcp__my_server__read_file', scope)).toBe(true);
    expect(isMcpToolVisible('mcp__other__read_file', scope)).toBe(false);
  });

  it('treats an empty allow-list as "no restriction"', () => {
    expect(isMcpToolVisible('mcp__anything__tool', toMcpVisibilityScope('standard', {}))).toBe(
      true,
    );
  });

  it('hides every MCP tool under the restricted profile', () => {
    const scope = toMcpVisibilityScope('restricted', { allowServers: ['my-server'] });

    expect(isMcpToolVisible('mcp__my_server__read_file', scope)).toBe(false);
  });
});

describe('isMcpToolVisible — reserved pseudo-server', () => {
  it('is exempt from allow_servers', () => {
    const scope = toMcpVisibilityScope('standard', { allowServers: ['filesystem'] });

    expect(isMcpToolVisible(`mcp__${MCP_RESERVED_SERVER}__read_resource`, scope)).toBe(true);
  });

  it('can still be blocked by deny_servers', () => {
    const scope = toMcpVisibilityScope('standard', { denyServers: [MCP_RESERVED_SERVER] });

    expect(isMcpToolVisible(`mcp__${MCP_RESERVED_SERVER}__read_resource`, scope)).toBe(false);
  });
});

describe('isMcpToolVisible — malformed names', () => {
  const scope = toMcpVisibilityScope('full', { denyServers: ['my-server'] });

  it('returns false for a name under the MCP prefix that does not parse', () => {
    // `undefined` would let these fall through to the `full` profile's
    // "everything is visible" branch, defeating deny_servers (§12.3).
    expect(isMcpToolVisible('mcp__x', scope)).toBe(false);
    expect(isMcpToolVisible('mcp__x__', scope)).toBe(false);
    expect(isMcpToolVisible('mcp__', scope)).toBe(false);
    expect(isMcpToolVisible('mcp____x', scope)).toBe(false);
  });

  it('returns undefined only for names that are not MCP tools at all', () => {
    expect(isMcpToolVisible('read_file', scope)).toBeUndefined();
    expect(isMcpToolVisible('', scope)).toBeUndefined();
  });
});
