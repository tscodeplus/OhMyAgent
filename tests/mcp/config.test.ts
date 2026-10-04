/**
 * Unit tests for the `mcp:` config seam
 * (MyDocs/MCP_INTEGRATION_DESIGN.md §5.1, §5.2).
 *
 * `src/mcp/config.ts` normalises the raw `config.yaml` section; the first half
 * of this file pins that normaliser, the second half pins the seam through
 * `config-loader.ts` / `loadConfig()` — including the backward-compatibility
 * promise that an absent `mcp:` section leaves `AppConfig.mcp` undefined.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MCP_SECTION,
  normaliseMcpSection,
  rawMcpServerSchema,
  toMcpVisibilityConfig,
} from '../../src/mcp/config.js';
import { loadConfig, mcpSectionSchema, resetConfig } from '../../src/app/config.js';
import { yamlToAppConfigRaw } from '../../src/app/config-loader.js';
import type {
  McpHttpServerConfig,
  McpSectionConfig,
  McpServerConfig,
  McpStdioServerConfig,
} from '../../src/mcp/types.js';

function expectStdio(section: McpSectionConfig, name: string): McpStdioServerConfig {
  const server = section.servers[name];
  if (server?.transport !== 'stdio') throw new Error(`expected "${name}" to be a stdio server`);
  return server;
}

function expectHttp(section: McpSectionConfig, name: string): McpHttpServerConfig {
  const server = section.servers[name];
  if (server?.transport !== 'http') throw new Error(`expected "${name}" to be an http server`);
  return server;
}

describe('normaliseMcpSection', () => {
  it('returns the documented defaults for an absent section', () => {
    expect(normaliseMcpSection(undefined)).toEqual(DEFAULT_MCP_SECTION);
    expect(normaliseMcpSection(null)).toEqual(DEFAULT_MCP_SECTION);
    expect(normaliseMcpSection({})).toEqual(DEFAULT_MCP_SECTION);
  });

  it('returns a fresh object so callers cannot poison the defaults', () => {
    const first = normaliseMcpSection(undefined);
    first.servers.poisoned = expectStdio(
      normaliseMcpSection({ servers: { a: { command: 'npx' } } }),
      'a',
    );
    first.allowServers.push('poisoned');

    expect(DEFAULT_MCP_SECTION.servers).toEqual({});
    expect(DEFAULT_MCP_SECTION.allowServers).toEqual([]);
    expect(normaliseMcpSection(undefined).allowServers).toEqual([]);
  });

  it('normalises a stdio server with per-server defaults', () => {
    const section = normaliseMcpSection({
      servers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
          env: { PORT: 8080 },
        },
      },
    });

    expect(expectStdio(section, 'filesystem')).toEqual({
      name: 'filesystem',
      enabled: true,
      exposure: 'deferred',
      toolExposure: {},
      toolEnabled: {},
      description: '',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
      env: { PORT: '8080' },
      cwd: '',
    });
  });

  it('round-trips tool_enabled, defaulting to an empty map', () => {
    const section = normaliseMcpSection({
      servers: {
        a: { command: 'npx', tool_enabled: { write_file: false, read_file: true } },
        b: { command: 'npx' },
      },
    });

    expect(expectStdio(section, 'a').toolEnabled).toEqual({ write_file: false, read_file: true });
    expect(expectStdio(section, 'b').toolEnabled).toEqual({});
    expect(mcpSectionSchema.safeParse(section).success).toBe(true);
  });

  it('rejects a non-boolean tool_enabled value as a server-level error', () => {
    const onServerError = vi.fn();
    const section = normaliseMcpSection(
      { servers: { a: { command: 'npx', tool_enabled: { write_file: 'no' } } } },
      { onServerError },
    );

    expect(section.servers).toEqual({});
    expect(onServerError.mock.calls[0][1]).toContain('tool_enabled');
  });

  it('normalises an http server and its oauth block', () => {
    const section = normaliseMcpSection({
      servers: {
        docs: {
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer token' },
          type: 'streamable-http',
          timeout_sec: '60',
          description: 'docs',
          oauth: { client_secret: 's3cret', scope: 'read' },
        },
      },
    });

    const server = expectHttp(section, 'docs');
    expect(server.exposure).toBe('deferred');
    expect(server.timeoutSec).toBe(60);
    expect(server.url).toBe('https://example.com/mcp');
    expect(server.headers).toEqual({ Authorization: 'Bearer token' });
    expect(server.oauth).toEqual({
      clientId: '',
      clientSecret: 's3cret',
      // Defaults from §5.1 / §10.3.
      callbackPort: 8765,
      callbackUrl: '',
      scope: 'read',
      clientName: 'OhMyAgent',
      authServerMetadataUrl: '',
    });
  });

  it('omits oauth entirely when the server declares none', () => {
    const section = normaliseMcpSection({ servers: { a: { command: 'npx' } } });
    expect('oauth' in expectStdio(section, 'a')).toBe(false);
  });

  it('aliases codemode to deferred, per tool and per server', () => {
    const section = normaliseMcpSection({
      servers: {
        a: {
          command: 'npx',
          exposure: 'codemode',
          tool_exposure: { read_file: 'direct', 'write_*': 'codemode', secret: 'hidden' },
        },
      },
    });

    const server = expectStdio(section, 'a');
    expect(server.exposure).toBe('deferred');
    expect(server.toolExposure).toEqual({
      read_file: 'direct',
      'write_*': 'deferred',
      secret: 'hidden',
    });
  });

  it('keeps a valid `type: stdio` hint', () => {
    const section = normaliseMcpSection({
      servers: { a: { command: 'npx', type: 'stdio' } },
    });
    expect(expectStdio(section, 'a').transport).toBe('stdio');
  });

  it('matches the normalised section schema it is consumed by', () => {
    const section = normaliseMcpSection({
      enabled: true,
      connect_timeout_sec: '30',
      allow_servers: ['filesystem'],
      servers: {
        filesystem: { command: 'npx', args: ['-y', 'server-filesystem'] },
        docs: { url: 'https://example.com/mcp' },
      },
    });

    expect(mcpSectionSchema.safeParse(section).success).toBe(true);
    // The reverse direction too: the raw section is *not* the normalised shape.
    expect(
      mcpSectionSchema.safeParse({ servers: { docs: { url: 'https://e.com' } } }).success,
    ).toBe(false);
  });

  it('skips a server whose command and url are both set', () => {
    const onServerError = vi.fn();
    const section = normaliseMcpSection(
      { servers: { docs: { command: 'npx', url: 'https://example.com/mcp' } } },
      { onServerError },
    );

    expect(section.servers).toEqual({});
    expect(onServerError).toHaveBeenCalledTimes(1);
    expect(onServerError.mock.calls[0][0]).toBe('docs');
    expect(onServerError.mock.calls[0][1]).toContain('mutually exclusive');
  });

  it('skips a server with neither command nor url', () => {
    const onServerError = vi.fn();
    const section = normaliseMcpSection({ servers: { docs: {} } }, { onServerError });

    expect(section.servers).toEqual({});
    expect(onServerError.mock.calls[0][1]).toContain('either `command` (stdio) or `url` (http)');
  });

  it('skips a server whose `type` contradicts its transport', () => {
    const onServerError = vi.fn();
    const section = normaliseMcpSection(
      { servers: { docs: { url: 'https://example.com/mcp', type: 'stdio' } } },
      { onServerError },
    );

    expect(section.servers).toEqual({});
    expect(onServerError.mock.calls[0][1]).toContain('contradicts');
  });

  it('rejects the unsupported legacy `sse` key instead of stripping it', () => {
    const onServerError = vi.fn();
    const section = normaliseMcpSection(
      { servers: { legacy: { url: 'https://example.com/sse', sse: true } } },
      { onServerError },
    );

    expect(section.servers).toEqual({});
    expect(onServerError).toHaveBeenCalledTimes(1);
    expect(onServerError.mock.calls[0][1]).toContain('sse');
  });

  it('reports an unknown exposure value and skips the server', () => {
    const onServerError = vi.fn();
    const section = normaliseMcpSection(
      { servers: { a: { command: 'npx', exposure: 'always' } } },
      { onServerError },
    );

    expect(section.servers).toEqual({});
    expect(onServerError).toHaveBeenCalledTimes(1);
  });

  it('skips a server name that is not identifier-like', () => {
    const onServerError = vi.fn();
    const section = normaliseMcpSection(
      { servers: { 'my server': { command: 'npx' } } },
      { onServerError },
    );

    expect(section.servers).toEqual({});
    expect(onServerError.mock.calls[0][0]).toBe('my server');
    expect(onServerError.mock.calls[0][1]).toContain('[A-Za-z0-9_-]');
  });

  it('rejects the reserved pseudo-server name `resources`', () => {
    const onServerError = vi.fn();
    const section = normaliseMcpSection(
      {
        servers: {
          resources: { command: 'npx' },
          good: { command: 'npx' },
        },
      },
      { onServerError },
    );

    expect(Object.keys(section.servers)).toEqual(['good']);
    expect(onServerError.mock.calls[0][0]).toBe('resources');
    expect(onServerError.mock.calls[0][1]).toContain('reserved');
  });

  it('rejects `__proto__` instead of letting it poison the server map', () => {
    const onServerError = vi.fn();
    // `JSON.parse` (and the YAML parser) keep `__proto__` as an own, enumerable
    // key — exactly the shape `yamlToAppConfigRaw()` hands to the normaliser.
    const rawServers = JSON.parse(
      '{"__proto__":{"command":"npx"},"good":{"command":"npx"}}',
    ) as Record<string, unknown>;

    const section = normaliseMcpSection({ servers: rawServers }, { onServerError });

    expect(Object.keys(section.servers)).toEqual(['good']);
    expect(onServerError).toHaveBeenCalledTimes(1);
    expect(onServerError.mock.calls[0][0]).toBe('__proto__');
    // Before the fix the entry vanished silently and `servers['enabled']`
    // resolved through the polluted prototype.
    expect(section.servers['enabled']).toBeUndefined();
    expect(Object.getPrototypeOf(section.servers)).toBeNull();
  });

  it('rejects `constructor` and `prototype` as server names', () => {
    const onServerError = vi.fn();
    const section = normaliseMcpSection(
      {
        servers: {
          constructor: { command: 'npx' },
          prototype: { command: 'npx' },
          good: { command: 'npx' },
        },
      },
      { onServerError },
    );

    expect(Object.keys(section.servers)).toEqual(['good']);
    expect(onServerError.mock.calls.map((call) => call[0])).toEqual(['constructor', 'prototype']);
  });

  it('drops out-of-range per-server scalars instead of failing startup (§5.2)', () => {
    const onServerError = vi.fn();
    const section = normaliseMcpSection(
      {
        servers: {
          zeroTimeout: { command: 'npx', timeout_sec: 0 },
          negativePort: { url: 'https://example.com/mcp', oauth: { callback_port: -1 } },
          good: { command: 'npx' },
        },
      },
      { onServerError },
    );

    expect(Object.keys(section.servers)).toEqual(['good']);
    expect(onServerError.mock.calls.map((call) => call[0])).toEqual([
      'zeroTimeout',
      'negativePort',
    ]);
    expect(onServerError.mock.calls[0][1]).toContain('timeout_sec');
    expect(onServerError.mock.calls[1][1]).toContain('callback_port');
    // The normalised section must still satisfy the schema the loader applies.
    expect(mcpSectionSchema.safeParse(section).success).toBe(true);
  });

  it('carries the documented `trust` override instead of dropping the server', () => {
    const onServerError = vi.fn();
    const section = normaliseMcpSection(
      { servers: { a: { command: 'npx', trust: 'read_only' } } },
      { onServerError },
    );

    expect(onServerError).not.toHaveBeenCalled();
    expect(expectStdio(section, 'a').trust).toBe('read_only');
    // A server without the key must stay byte-identical to the pre-trust shape.
    expect(
      'trust' in expectStdio(normaliseMcpSection({ servers: { b: { command: 'npx' } } }), 'b'),
    ).toBe(false);
    expect(mcpSectionSchema.safeParse(section).success).toBe(true);

    const bad = normaliseMcpSection(
      { servers: { a: { command: 'npx', trust: 'sometimes' } } },
      { onServerError },
    );
    expect(bad.servers).toEqual({});
    expect(onServerError.mock.calls[0][1]).toContain('trust');
  });

  it('throws when two server names differ only in "-" vs "_"', () => {
    expect(() =>
      normaliseMcpSection({
        servers: { 'my-server': { command: 'npx' }, my_server: { command: 'npx' } },
      }),
    ).toThrow(/differing only in "-" vs "_"/);
  });

  it('reports a type-invalid scalar and falls back to the default', () => {
    const onScalarError = vi.fn();
    const section = normaliseMcpSection(
      { enabled: 'yes', connect_timeout_sec: 'nope', allow_servers: 42 },
      { onScalarError },
    );

    expect(section.enabled).toBe(true);
    expect(section.connectTimeoutSec).toBe(DEFAULT_MCP_SECTION.connectTimeoutSec);
    expect(section.allowServers).toEqual([]);
    expect(onScalarError.mock.calls.map((call) => call[0])).toEqual([
      'mcp.enabled',
      'mcp.connect_timeout_sec',
      'mcp.allow_servers',
    ]);
  });

  it('accepts numeric strings for section scalars, so ${ENV} keeps working', () => {
    const section = normaliseMcpSection({
      connect_timeout_sec: '30',
      request_timeout_sec: '90',
      max_output_bytes: '1024',
      max_concurrent_connects: '2',
      inject_system_prompt: 'false',
    });

    expect(section.connectTimeoutSec).toBe(30);
    expect(section.requestTimeoutSec).toBe(90);
    expect(section.maxOutputBytes).toBe(1024);
    expect(section.maxConcurrentConnects).toBe(2);
    expect(section.injectSystemPrompt).toBe(false);
  });

  it('reads allow_servers / deny_servers from a list or a comma string', () => {
    expect(
      normaliseMcpSection({ allow_servers: ['a', ' b '], deny_servers: 'x, y' }),
    ).toMatchObject({ allowServers: ['a', 'b'], denyServers: ['x', 'y'] });
  });

  it('reports a non-mapping section and a non-mapping servers key', () => {
    const onScalarError = vi.fn();
    expect(normaliseMcpSection('on', { onScalarError })).toEqual(DEFAULT_MCP_SECTION);
    expect(onScalarError.mock.calls[0][0]).toBe('mcp');

    onScalarError.mockClear();
    expect(normaliseMcpSection({ servers: ['a'] }, { onScalarError })).toEqual(DEFAULT_MCP_SECTION);
    expect(onScalarError.mock.calls[0][0]).toBe('mcp.servers');
  });

  it('boundaries: `rawMcpServerSchema` is strict', () => {
    expect(rawMcpServerSchema.safeParse({ command: 'npx', unknown_key: 1 }).success).toBe(false);
    expect(rawMcpServerSchema.safeParse({ command: 'npx' }).success).toBe(true);
  });
});

describe('toMcpVisibilityConfig', () => {
  it('maps an unconfigured section to "no restriction"', () => {
    expect(toMcpVisibilityConfig(undefined)).toEqual({ allowServers: [], denyServers: [] });
    expect(toMcpVisibilityConfig(null)).toEqual({ allowServers: [], denyServers: [] });
  });

  it('passes the configured lists through', () => {
    const section = normaliseMcpSection({
      allow_servers: ['filesystem'],
      deny_servers: ['docs'],
    });
    expect(toMcpVisibilityConfig(section)).toEqual({
      allowServers: ['filesystem'],
      denyServers: ['docs'],
    });
  });
});

describe('config.yaml → AppConfig.mcp', () => {
  beforeEach(() => {
    resetConfig();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetConfig();
  });

  it('leaves mcp undefined when the section is absent', () => {
    const raw = yamlToAppConfigRaw({ provider: { primary: 'openai/gpt-4o' } });
    expect(raw.mcp).toBeUndefined();
  });

  it('maps and normalises the section, logging servers it drops', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = yamlToAppConfigRaw({
      mcp: {
        connect_timeout_sec: 20,
        servers: {
          filesystem: { command: 'npx', args: ['-y', 'server-filesystem'] },
          broken: { command: 'npx', url: 'https://example.com/mcp' },
        },
      },
    });

    const section = raw.mcp as McpSectionConfig | undefined;
    expect(section?.connectTimeoutSec).toBe(20);
    expect(Object.keys(section?.servers ?? {})).toEqual(['filesystem']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[mcp] skipping server "broken"'));
  });

  it('fails fast on a type-invalid scalar inside the section', () => {
    expect(() => yamlToAppConfigRaw({ mcp: { enabled: 'yes' } })).toThrow(/mcp\.enabled/);
    expect(() => yamlToAppConfigRaw({ mcp: { servers: ['filesystem'] } })).toThrow(/mcp\.servers/);
    expect(() =>
      yamlToAppConfigRaw({
        mcp: { servers: { 'a-b': { command: 'npx' }, a_b: { command: 'npx' } } },
      }),
    ).toThrow(/differing only in "-" vs "_"/);
  });

  it('keeps the two error classes apart: section-level throws, server-level only logs', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Server-level: a server nobody can identify is dropped, the rest survives
    // and startup is not blocked.
    const raw = yamlToAppConfigRaw({
      mcp: { servers: { broken: { command: 'npx', url: 'https://example.com/mcp' } } },
    });
    expect(raw.mcp).toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('broken');

    // Section-level: the same kind of mistake must never land in a warning.
    warn.mockClear();
    expect(() => yamlToAppConfigRaw({ mcp: { enabled: 'yes' } })).toThrow(/Invalid config\.yaml/);
    expect(warn).not.toHaveBeenCalled();
  });

  it('loads an mcp: section end-to-end, with ${ENV} interpolation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oma-mcp-'));
    try {
      const configPath = join(dir, 'config.yaml');
      writeFileSync(
        configPath,
        [
          'ui_language: en',
          'mcp:',
          '  enabled: true',
          '  servers:',
          '    docs:',
          '      url: https://example.com/mcp',
          '      headers:',
          '        Authorization: "Bearer ${DOCS_TOKEN}"',
          '      exposure: codemode',
          '      trust: read_only',
          '      tool_enabled:',
          '        write_page: false',
          '',
        ].join('\n'),
        'utf-8',
      );

      const config = loadConfig({ DOCS_TOKEN: 'sk-from-env' }, configPath);

      expect(config.mcp?.enabled).toBe(true);
      expect(expectHttp(config.mcp!, 'docs').headers).toEqual({
        Authorization: 'Bearer sk-from-env',
      });
      expect(config.mcp?.servers.docs.exposure).toBe('deferred');
      // Both keys have to survive normalisation *and* the AppConfig schema.
      expect(config.mcp?.servers.docs.trust).toBe('read_only');
      expect(config.mcp?.servers.docs.toolEnabled).toEqual({ write_page: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      resetConfig();
    }
  });

  it('keeps a config without mcp: byte-identical in shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oma-mcp-off-'));
    try {
      const configPath = join(dir, 'config.yaml');
      writeFileSync(configPath, 'ui_language: en\n', 'utf-8');

      const config = loadConfig({}, configPath);
      expect(config.mcp).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      resetConfig();
    }
  });

  it('boots past an out-of-range per-server scalar instead of dying (§5.2)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), 'oma-mcp-range-'));
    try {
      const configPath = join(dir, 'config.yaml');
      writeFileSync(
        configPath,
        [
          'ui_language: en',
          'mcp:',
          '  servers:',
          '    slow:',
          '      command: npx',
          '      timeout_sec: 0',
          '    good:',
          '      command: npx',
          '',
        ].join('\n'),
        'utf-8',
      );

      const config = loadConfig({}, configPath);

      expect(Object.keys(config.mcp?.servers ?? {})).toEqual(['good']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[mcp] skipping server "slow"'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      resetConfig();
    }
  });

  it('drops a `__proto__` server through the loader seam instead of swallowing it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // `yamlToAppConfigRaw()` receives the parsed (already interpolated) root,
    // and `parseYaml` keeps `__proto__` as an own enumerable key — the shape
    // that used to poison the server map with no report at all.
    const raw = yamlToAppConfigRaw(
      parseYaml(
        [
          'ui_language: en',
          'mcp:',
          '  servers:',
          '    __proto__:',
          '      command: npx',
          '    good:',
          '      command: npx',
          '',
        ].join('\n'),
      ),
    );

    const section = raw.mcp as McpSectionConfig | undefined;
    const servers: Record<string, McpServerConfig> = section?.servers ?? {};
    expect(Object.keys(servers)).toEqual(['good']);
    expect(servers['enabled']).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"__proto__"'));
  });
});
