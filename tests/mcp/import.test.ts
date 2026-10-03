/**
 * Tests for `scripts/mcp-import.ts` (design §5.3, decision 19-2).
 *
 * The import command is the only writer that turns a foreign `mcp.json` into
 * `config.yaml`, so these tests pin: the accepted shape, the stdio/http
 * translation, the outright `sse` rejection, the never-overwrite conflict rule,
 * `--dry-run` leaving the file untouched, and — the end-to-end promise — a
 * successfully imported file being readable back by `loadConfig()` with the
 * same servers.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  McpImportConflictError,
  McpImportError,
  importMcpJson,
  parseMcpJson,
  planImport,
  runMcpImport,
  translateMcpServer,
} from '../../scripts/mcp-import.js';
import { loadConfig, resetConfig } from '../../src/app/config.js';

let dir: string;
let configPath: string;
let mcpJsonPath: string;
let previousConfigFile: string | undefined;
/** Discards the command's human-readable plan so test output stays readable. */
const quiet = () => {};

const SAMPLE_MCP_JSON = JSON.stringify(
  {
    mcpServers: {
      filesystem: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
        env: { CACHE_DIR: '/tmp/mcp-cache' },
        cwd: '/work',
      },
      docs: {
        type: 'streamable-http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
      },
      'plain-http': {
        url: 'https://example.org/mcp',
      },
    },
  },
  null,
  2,
);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oma-mcp-import-'));
  configPath = join(dir, 'config.yaml');
  mcpJsonPath = join(dir, 'mcp.json');
  writeFileSync(configPath, 'ui_language: en\n', 'utf-8');
  writeFileSync(mcpJsonPath, SAMPLE_MCP_JSON, 'utf-8');
  previousConfigFile = process.env.CONFIG_FILE;
  process.env.CONFIG_FILE = configPath;
  resetConfig();
});

afterEach(() => {
  if (previousConfigFile === undefined) delete process.env.CONFIG_FILE;
  else process.env.CONFIG_FILE = previousConfigFile;
  resetConfig();
  rmSync(dir, { recursive: true, force: true });
});

describe('parseMcpJson', () => {
  it('returns the mcpServers mapping', () => {
    const servers = parseMcpJson(SAMPLE_MCP_JSON, 'mcp.json');
    expect(Object.keys(servers)).toEqual(['filesystem', 'docs', 'plain-http']);
  });

  it('rejects invalid JSON, a non-object root and a missing mcpServers key', () => {
    expect(() => parseMcpJson('{ nope', 'mcp.json')).toThrow(/not valid JSON/);
    expect(() => parseMcpJson('[]', 'mcp.json')).toThrow(/JSON object at the top level/);
    expect(() => parseMcpJson('{"servers":{}}', 'mcp.json')).toThrow(/no "mcpServers" key/);
    expect(() => parseMcpJson('{"mcpServers":[]}', 'mcp.json')).toThrow(
      /"mcpServers" must be an object/,
    );
  });
});

describe('translateMcpServer', () => {
  it('translates a stdio entry to the config.yaml shape', () => {
    const server = translateMcpServer('filesystem', {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
      env: { CACHE_DIR: '/tmp/mcp-cache' },
      cwd: '/work',
    });

    expect(server.transport).toBe('stdio');
    expect(server.entry).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
      env: { CACHE_DIR: '/tmp/mcp-cache' },
      cwd: '/work',
    });
  });

  it('translates an http entry and normalises streamable-http to type: http', () => {
    const server = translateMcpServer('docs', {
      type: 'streamable-http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
    });

    expect(server.transport).toBe('http');
    expect(server.entry).toEqual({
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
      type: 'http',
    });
  });

  it('omits empty args/env/cwd so the imported YAML stays readable', () => {
    const server = translateMcpServer('plain', { command: 'node', args: [], env: {}, cwd: '' });
    expect(server.entry).toEqual({ command: 'node' });
  });

  it('stringifies scalar args and env values', () => {
    const server = translateMcpServer('types', {
      command: 'node',
      args: [8080, true],
      env: { N: 1 },
    });
    expect(server.entry).toEqual({ command: 'node', args: ['8080', 'true'], env: { N: '1' } });
  });

  it('passes through our own keys and reports the mcp.json keys it drops', () => {
    const server = translateMcpServer('ours', {
      command: 'npx',
      exposure: 'direct',
      tool_exposure: { 'write_*': 'hidden' },
      timeout_sec: 30,
      description: 'local tools',
      disabled: false,
      autoApprove: ['read_file'],
    });

    expect(server.entry).toEqual({
      command: 'npx',
      exposure: 'direct',
      tool_exposure: { 'write_*': 'hidden' },
      timeout_sec: 30,
      description: 'local tools',
    });
    expect(server.ignoredKeys).toEqual(['disabled', 'autoApprove']);
  });

  it('rejects sse with a message that names the transport', () => {
    expect(() => translateMcpServer('legacy', { type: 'sse', url: 'https://x/sse' })).toThrow(
      McpImportError,
    );
    expect(() => translateMcpServer('legacy', { type: 'sse', url: 'https://x/sse' })).toThrow(
      /transport "sse" is not supported/,
    );
  });

  it('rejects entries with neither or both transport keys', () => {
    expect(() => translateMcpServer('neither', { args: [] })).toThrow(
      /either `command` \(stdio\) or `url` \(http\) is required/,
    );
    expect(() => translateMcpServer('both', { command: 'npx', url: 'https://x' })).toThrow(
      /mutually exclusive/,
    );
  });

  it('rejects a type that contradicts the transport keys and unknown types', () => {
    expect(() => translateMcpServer('odd', { type: 'stdio', url: 'https://x' })).toThrow(
      /contradicts the configured `url` \(http\)/,
    );
    expect(() => translateMcpServer('odd', { type: 'websocket', url: 'https://x' })).toThrow(
      /unknown `type`/,
    );
  });

  it('rejects malformed args/env', () => {
    expect(() => translateMcpServer('bad', { command: 'npx', args: '-y pkg' })).toThrow(
      /`args` must be an array/,
    );
    expect(() => translateMcpServer('bad', { command: 'npx', env: ['A=1'] })).toThrow(
      /`env` must be an object/,
    );
  });

  it('rejects a value the config loader would drop', () => {
    expect(() => translateMcpServer('bad', { command: 'npx', exposure: 'always' })).toThrow(
      /exposure/,
    );
  });
});

describe('planImport', () => {
  it('separates new, unchanged and conflicting servers', () => {
    const imported = [
      translateMcpServer('fresh', { command: 'npx' }),
      translateMcpServer('same', { command: 'node' }),
      translateMcpServer('changed', { command: 'node', args: ['new'] }),
    ];

    const plan = planImport(imported, {
      same: { command: 'node' },
      changed: { command: 'node', args: ['old'], cwd: '/old' },
    });

    expect(plan.added.map((s) => s.name)).toEqual(['fresh']);
    expect(plan.unchanged).toEqual(['same']);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].name).toBe('changed');
    expect(plan.conflicts[0].diffs).toEqual(['args: ["old"] -> ["new"]', '- cwd: "/old"']);
  });

  it('treats my-server and my_server as the same server', () => {
    const plan = planImport([translateMcpServer('my-server', { command: 'npx' })], {
      my_server: { command: 'npx' },
    });
    expect(plan.added).toEqual([]);
    expect(plan.unchanged).toEqual(['my-server']);
  });

  it('rejects two names inside mcp.json that collapse to the same server', () => {
    expect(() =>
      planImport(
        [
          translateMcpServer('my-server', { command: 'a' }),
          translateMcpServer('my_server', { command: 'b' }),
        ],
        {},
      ),
    ).toThrow(/declares both/);
  });
});

describe('importMcpJson', () => {
  it('writes every translated server and reads back through loadConfig()', async () => {
    const result = await importMcpJson({ mcpJsonPath, log: quiet, dryRun: false });

    expect(result.added.map((s) => s.name)).toEqual(['filesystem', 'docs', 'plain-http']);
    expect(readFileSync(configPath, 'utf-8')).toContain('mcp:');

    const config = loadConfig({ DOCS_TOKEN: 'sk-from-env' }, configPath);
    expect(config.mcp?.enabled).toBe(true);
    expect(Object.keys(config.mcp?.servers ?? {}).sort()).toEqual([
      'docs',
      'filesystem',
      'plain-http',
    ]);
    expect(config.mcp?.servers.filesystem).toMatchObject({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
      env: { CACHE_DIR: '/tmp/mcp-cache' },
      cwd: '/work',
      exposure: 'deferred',
    });
    expect(config.mcp?.servers.docs).toMatchObject({
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer sk-from-env' },
    });
  });

  it('preserves unrelated config.yaml content and existing comments', async () => {
    writeFileSync(
      configPath,
      ['# keep me', 'ui_language: en', '', 'mcp:', '  enabled: false  # off for now', ''].join(
        '\n',
      ),
      'utf-8',
    );

    await importMcpJson({ mcpJsonPath: mcpJsonPath, log: quiet });

    const written = readFileSync(configPath, 'utf-8');
    expect(written).toContain('# keep me');
    expect(written).toContain('# off for now');
    const config = loadConfig({}, configPath);
    expect(config.mcp?.enabled).toBe(false);
    expect(Object.keys(config.mcp?.servers ?? {}).length).toBe(3);
  });

  it('--dry-run prints the plan and writes nothing', async () => {
    const before = readFileSync(configPath, 'utf-8');
    const lines: string[] = [];

    const result = await importMcpJson({ mcpJsonPath, dryRun: true, log: (l) => lines.push(l) });

    expect(result.added).toHaveLength(3);
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
    expect(lines.join('\n')).toContain('--dry-run: nothing written');
    expect(lines.join('\n')).toContain('+ filesystem (stdio)');
    expect(lines.join('\n')).toContain('url: https://example.com/mcp');
  });

  it('is idempotent: a second run changes nothing and reports unchanged', async () => {
    await importMcpJson({ mcpJsonPath, log: quiet });
    const afterFirst = readFileSync(configPath, 'utf-8');

    const second = await importMcpJson({ mcpJsonPath, log: quiet });

    expect(second.added).toEqual([]);
    expect(second.unchanged).toEqual(['filesystem', 'docs', 'plain-http']);
    expect(readFileSync(configPath, 'utf-8')).toBe(afterFirst);
  });

  it('refuses to overwrite a same-named server and lists the differences', async () => {
    writeFileSync(
      configPath,
      [
        'ui_language: en',
        'mcp:',
        '  servers:',
        '    filesystem:',
        '      command: npx',
        '      args: ["-y", "@modelcontextprotocol/server-filesystem", "/srv"]',
        '      description: "hand written"',
        '',
      ].join('\n'),
      'utf-8',
    );
    const before = readFileSync(configPath, 'utf-8');

    const error = await importMcpJson({ mcpJsonPath, log: quiet }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpImportConflictError);
    const conflict = error as McpImportConflictError;
    expect(conflict.conflicts.map((c) => c.name)).toEqual(['filesystem']);
    expect(conflict.message).toContain('config.yaml was NOT modified');
    expect(conflict.message).toContain(
      'args: ["-y","@modelcontextprotocol/server-filesystem","/srv"]',
    );
    expect(conflict.message).toContain('- description: "hand written"');
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('reports a missing file and an empty mcpServers map', async () => {
    await expect(
      importMcpJson({ mcpJsonPath: join(dir, 'nope.json'), log: quiet }),
    ).rejects.toThrow(/not found/);

    writeFileSync(mcpJsonPath, '{"mcpServers":{}}', 'utf-8');
    await expect(importMcpJson({ mcpJsonPath, log: quiet })).rejects.toThrow(
      /"mcpServers" is empty/,
    );
  });

  it('aborts on an sse entry without writing anything', async () => {
    writeFileSync(
      mcpJsonPath,
      JSON.stringify({ mcpServers: { legacy: { type: 'sse', url: 'https://x/sse' } } }),
      'utf-8',
    );
    const before = readFileSync(configPath, 'utf-8');

    await expect(importMcpJson({ mcpJsonPath, log: quiet })).rejects.toThrow(
      /transport "sse" is not supported/,
    );
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });
});

describe('runMcpImport', () => {
  it('returns 0 and writes on success', async () => {
    expect(await runMcpImport([mcpJsonPath], { log: quiet })).toBe(0);
    expect(readFileSync(configPath, 'utf-8')).toContain('filesystem');
  });

  it('returns 1 and leaves the file alone on conflict', async () => {
    writeFileSync(
      configPath,
      ['ui_language: en', 'mcp:', '  servers:', '    filesystem:', '      command: other', ''].join(
        '\n',
      ),
      'utf-8',
    );
    const before = readFileSync(configPath, 'utf-8');

    expect(await runMcpImport([mcpJsonPath], { log: quiet })).toBe(1);
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('returns 1 for unknown options and extra positional arguments', async () => {
    expect(await runMcpImport(['--nope'], { log: quiet })).toBe(1);
    expect(await runMcpImport(['a.json', 'b.json'], { log: quiet })).toBe(1);
  });

  it('creates config.yaml when it does not exist yet', async () => {
    rmSync(configPath, { force: true });

    expect(await runMcpImport([mcpJsonPath], { log: quiet })).toBe(0);
    expect(existsSync(configPath)).toBe(true);
    expect(loadConfig({}, configPath).mcp?.servers.filesystem.transport).toBe('stdio');
  });
});
