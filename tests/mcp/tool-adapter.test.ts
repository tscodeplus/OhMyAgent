/**
 * MCP tool adapter tests (MyDocs/MCP_INTEGRATION_DESIGN.md §6.1-§6.6, §8.1).
 *
 * Covers naming (sanitise / 64-char cap / hash suffix), exposure resolution,
 * input-schema normalisation, annotation → capability mapping and the
 * `execute()` contract: `isError` mapping, `structuredContent` passthrough and
 * oversized-output spilling.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CallToolResult, Tool } from '@earendil-works/pi-mcp';
import { capabilityFromAnnotations, mcpAnnotationFlags } from '../../src/mcp/capability.js';
import { limitMcpOutput } from '../../src/mcp/offload.js';
import {
  MCP_TOOL_NAME_MAX_LENGTH,
  createMcpToolName,
  resolveMcpExposure,
  toMcpToolDefinition,
} from '../../src/mcp/tool-adapter.js';
import type { McpServerConfig, McpStdioServerConfig } from '../../src/mcp/types.js';
import { OffloadStore } from '../../src/runtime-artifacts/offload-store.js';
import { createToolContext } from '../../src/tools/platform/tool-context.js';
import type { AppServices } from '../../src/app/types.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcp-adapter-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function stdioServer(overrides: Partial<McpStdioServerConfig> = {}): McpStdioServerConfig {
  return {
    name: 'fs',
    enabled: true,
    exposure: 'deferred',
    toolExposure: {},
    description: '',
    transport: 'stdio',
    command: 'npx',
    args: [],
    env: {},
    cwd: '',
    ...overrides,
  };
}

function tool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: 'read_file',
    description: 'read a file',
    inputSchema: { properties: { path: { type: 'string' } } },
    ...overrides,
  };
}

// ── Naming ──────────────────────────────────────────────────────────────────

describe('createMcpToolName', () => {
  it('builds mcp__<server>__<tool> and sanitises illegal characters', () => {
    expect(createMcpToolName('fs', 'read_file')).toBe('mcp__fs__read_file');
    expect(createMcpToolName('my-server', 'read/file')).toBe('mcp__my_server__read_file');
    expect(createMcpToolName('fs', 'read.file:v2')).toBe('mcp__fs__read_file_v2');
  });

  it('caps the name at 64 characters, keeping the tool segment recognisable', () => {
    const longTool = 'x'.repeat(200);
    const name = createMcpToolName('fs', longTool);

    expect(name.length).toBe(MCP_TOOL_NAME_MAX_LENGTH);
    expect(name).toMatch(/_([0-9a-f]{8})$/);
    expect(name.startsWith('mcp__fs__')).toBe(true);
  });

  it('appends an 8-char hash when the plain name is already taken', () => {
    const plain = createMcpToolName('fs', 'read_file');
    const hashed = createMcpToolName('fs', 'read_file', (candidate) => candidate === plain);

    expect(hashed).not.toBe(plain);
    expect(hashed).toMatch(/^mcp__fs__read_file_[0-9a-f]{8}$/);
  });

  it('is deterministic for the same server + tool pair', () => {
    const taken = () => true;
    expect(createMcpToolName('fs', 'read_file', taken)).toBe(
      createMcpToolName('fs', 'read_file', taken),
    );
  });
});

// ── Exposure ────────────────────────────────────────────────────────────────

describe('resolveMcpExposure', () => {
  it('falls back to the server default', () => {
    expect(resolveMcpExposure(stdioServer({ exposure: 'hidden' }), 'read_file')).toBe('hidden');
  });

  it('prefers an exact override over the first matching wildcard', () => {
    const server = stdioServer({
      exposure: 'deferred',
      toolExposure: { 'read_*': 'hidden', read_file: 'direct' },
    });

    expect(resolveMcpExposure(server, 'read_file')).toBe('direct');
    expect(resolveMcpExposure(server, 'read_dir')).toBe('hidden');
    expect(resolveMcpExposure(server, 'write_file')).toBe('deferred');
  });

  it('treats a bare * as a wildcard and a mid-name * as a literal', () => {
    expect(resolveMcpExposure(stdioServer({ toolExposure: { '*': 'hidden' } }), 'any')).toBe(
      'hidden',
    );
    expect(
      resolveMcpExposure(stdioServer({ toolExposure: { 'read*file': 'hidden' } }), 'readXfile'),
    ).toBe('deferred');
  });
});

// ── Capability ──────────────────────────────────────────────────────────────

describe('capabilityFromAnnotations', () => {
  it('reads the four annotation flags, treating absent hints as false', () => {
    expect(mcpAnnotationFlags(undefined)).toEqual({
      readOnly: false,
      destructive: false,
      idempotent: false,
      openWorld: false,
    });
    expect(
      mcpAnnotationFlags({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      }),
    ).toEqual({ readOnly: true, destructive: false, idempotent: true, openWorld: true });
  });

  it('maps read-only to auto-approve and absent annotations to mutating', () => {
    expect(capabilityFromAnnotations({ readOnlyHint: true }, stdioServer())).toMatchObject({
      category: 'mcp',
      readOnly: true,
      approvalDefault: 'none',
      usesNetwork: false,
    });
    expect(capabilityFromAnnotations(undefined, stdioServer())).toMatchObject({
      readOnly: false,
      approvalDefault: 'mutating',
    });
  });

  it('lets destructive win over read-only and marks HTTP servers as networked', () => {
    const http: McpServerConfig = {
      name: 'docs',
      enabled: true,
      exposure: 'deferred',
      toolExposure: {},
      description: '',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: {},
    };

    expect(
      capabilityFromAnnotations({ readOnlyHint: true, destructiveHint: true }, stdioServer()),
    ).toMatchObject({ readOnly: false, approvalDefault: 'high_risk' });
    expect(capabilityFromAnnotations(undefined, http).usesNetwork).toBe(true);
  });
});

// ── Definition + execute ────────────────────────────────────────────────────

interface AdapterHarness {
  def: ReturnType<typeof toMcpToolDefinition>;
  store: OffloadStore;
  baseDir: string;
  calls: Array<{ toolName: string; args: Record<string, unknown> }>;
}

function createAdapter(options: {
  result?: CallToolResult;
  error?: Error;
  maxBytes?: number;
  exposure?: 'direct' | 'deferred' | 'hidden';
  annotations?: Tool['annotations'];
}): AdapterHarness {
  const baseDir = tempDir();
  const store = new OffloadStore(baseDir);
  const calls: AdapterHarness['calls'] = [];

  const def = toMcpToolDefinition({
    server: stdioServer(),
    tool: tool({ ...(options.annotations ? { annotations: options.annotations } : {}) }),
    name: 'mcp__fs__read_file',
    exposure: options.exposure ?? 'deferred',
    callTool: async (toolName, args) => {
      calls.push({ toolName, args });
      if (options.error) throw options.error;
      return options.result ?? { content: [{ type: 'text', text: 'ok' }] };
    },
    offload: { store, maxBytes: options.maxBytes ?? 20_480 },
  });

  return { def, store, baseDir, calls };
}

describe('toMcpToolDefinition', () => {
  it('fills in an object schema with properties', () => {
    const { def } = createAdapter({});
    expect(def.parametersSchema).toEqual({
      type: 'object',
      properties: { path: { type: 'string' } },
    });
    expect(def.category).toBe('mcp');
    expect(def.name).toBe('mcp__fs__read_file');
    expect(def.label).toBe('read_file');
    expect(def.description).toBe('read a file');
  });

  it('marks only non-direct tools as deferrable', () => {
    expect(createAdapter({ exposure: 'direct' }).def.deferrable).toBe(false);
    expect(createAdapter({ exposure: 'deferred' }).def.deferrable).toBe(true);
  });

  it('forwards arguments and maps isError onto the tool result', async () => {
    const { def, calls } = createAdapter({
      result: { content: [{ type: 'text', text: 'boom' }], isError: true },
    });

    const result = await def.execute(
      { path: '/tmp/x' },
      createToolContext({} as AppServices, { sessionId: 's1' }),
    );

    expect(calls).toEqual([{ toolName: 'read_file', args: { path: '/tmp/x' } }]);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'boom' }]);
  });

  it('passes structuredContent through to metadata without hiding it from the model', async () => {
    const { def } = createAdapter({
      result: {
        content: [],
        structuredContent: { files: ['a', 'b'] },
      },
    });

    const result = await def.execute({}, createToolContext({} as AppServices));

    expect(result.metadata?.structuredContent).toEqual({ files: ['a', 'b'] });
    // `toLlmContent()` stringifies structuredContent when there are no blocks,
    // so the model still sees the payload (§6.4).
    expect((result.content[0] as { text: string }).text).toContain('"a"');
  });

  it('turns a transport failure into error text instead of throwing', async () => {
    const { def } = createAdapter({ error: new Error('server is not connected') });

    const result = await def.execute({}, createToolContext({} as AppServices));

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('server is not connected');
  });

  it('spills oversized output and names the spill path in metadata', async () => {
    const big = 'Y'.repeat(5_000);
    const { def, baseDir } = createAdapter({
      maxBytes: 256,
      result: { content: [{ type: 'text', text: big }] },
    });

    const result = await def.execute(
      {},
      createToolContext({} as AppServices, { sessionId: 'sess-7' }),
    );

    const fullOutputPath = result.metadata?.fullOutputPath as string;
    expect(path.resolve(fullOutputPath)).toBe(
      path.join(path.resolve(baseDir), 'offload', 'sess-7', 'spill', path.basename(fullOutputPath)),
    );
    expect(existsSync(fullOutputPath)).toBe(true);
    expect(readFileSync(fullOutputPath, 'utf-8')).toBe(big);

    const text = (result.content[0] as { text: string }).text;
    expect(text.startsWith('Y')).toBe(true);
    expect(text.endsWith('Y')).toBe(true);
    expect(text).toContain(`[Full output: ${fullOutputPath}`);
  });

  it('keeps image blocks after a truncated text block', async () => {
    const { def } = createAdapter({
      maxBytes: 64,
      result: {
        content: [
          { type: 'text', text: 'Z'.repeat(2_000) },
          { type: 'image', data: 'aGk=', mimeType: 'image/png' },
        ],
      },
    });

    const result = await def.execute({}, createToolContext({} as AppServices));

    expect(result.content).toHaveLength(2);
    expect(result.content[0].type).toBe('text');
    expect(result.content[1]).toEqual({ type: 'image', data: 'aGk=', mimeType: 'image/png' });
  });
});

// ── limitMcpOutput ──────────────────────────────────────────────────────────

describe('limitMcpOutput', () => {
  it('passes content through untouched when it fits', () => {
    const store = new OffloadStore(tempDir());
    const content = [
      { type: 'text' as const, text: 'small' },
      { type: 'image' as const, data: 'aGk=', mimeType: 'image/png' },
    ];

    const limited = limitMcpOutput(content, {
      store,
      maxBytes: 100,
      sessionKey: 's1',
      toolName: 'mcp__fs__read_file',
    });

    expect(limited.truncated).toBe(false);
    expect(limited.fullOutputPath).toBeUndefined();
    expect(limited.content).toEqual(content);
  });

  it('merges text blocks for the size decision and never splits a surrogate pair', () => {
    const baseDir = tempDir();
    const store = new OffloadStore(baseDir);
    const text = '😀'.repeat(1_000);

    const limited = limitMcpOutput([{ type: 'text', text }], {
      store,
      maxBytes: 40,
      sessionKey: 's2',
      toolName: 'mcp__fs__read_file',
    });

    expect(limited.truncated).toBe(true);
    const body = (limited.content[0] as { text: string }).text;
    const head = body.slice(0, body.indexOf('\n\n['));
    expect(head.length % 2).toBe(0);
    expect([...head].every((char) => char === '😀')).toBe(true);
  });
});
