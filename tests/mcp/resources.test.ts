/**
 * Unit tests for the three MCP resource tools
 * (MyDocs/MCP_INTEGRATION_DESIGN.md §11, §12.3).
 *
 * The manager and the resource surface are stubs: these tests pin tool naming,
 * the reserved-server visibility path, result shaping (text / image / spilled
 * binary), MCP Apps filtering and the single retry on 408/429/5xx.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createResourceToolDefinitions,
  MCP_RESOURCE_TOOL_NAMES,
  MCP_RESOURCES_LIST_TEMPLATES_TOOL_NAME,
  MCP_RESOURCES_LIST_TOOL_NAME,
  MCP_RESOURCES_READ_TOOL_NAME,
  mcpResourceToolCapability,
  shouldRegisterResourceTools,
} from '../../src/mcp/resources.js';
import type { McpManager, McpResourceAccess, McpServerState } from '../../src/mcp/types.js';
import {
  isMcpToolVisible,
  MCP_RESERVED_SERVER,
  serverNameOfMcpTool,
  toMcpVisibilityScope,
} from '../../src/policy/mcp-visibility.js';
import { DEFAULT_POLICY_SCOPE } from '../../src/policy/types.js';
import { OffloadStore } from '../../src/runtime-artifacts/offload-store.js';
import type { ToolExecutionContext } from '../../src/tools/platform/tool-context.js';
import type { ToolExecutionResult } from '../../src/tools/platform/tool-result.js';
import { McpHttpError } from '@earendil-works/pi-mcp';

function serverState(name: string, overrides: Partial<McpServerState> = {}): McpServerState {
  return {
    name,
    state: 'connected',
    tools: [],
    errorCount: 0,
    updatedAt: Date.now(),
    authRequired: false,
    supportsResources: true,
    supportsPrompts: false,
    ...overrides,
  };
}

function stubManager(servers: McpServerState[]): McpManager {
  return {
    listServers: () => servers,
    getServerState: (name: string) => servers.find((server) => server.name === name),
  } as unknown as McpManager;
}

function stubAccess(overrides: Partial<McpResourceAccess> = {}): McpResourceAccess {
  return {
    listResources: vi.fn(async () => ({ resources: [] })),
    listResourceTemplates: vi.fn(async () => ({ resourceTemplates: [] })),
    readResource: vi.fn(async () => ({ contents: [] })),
    serversWithResources: vi.fn(() => []),
    ...overrides,
  };
}

function ctx(sessionId = 'session-1'): ToolExecutionContext {
  return {
    cwd: process.cwd(),
    policyScope: DEFAULT_POLICY_SCOPE,
    services: {} as ToolExecutionContext['services'],
    sessionId,
  };
}

function textOf(result: ToolExecutionResult): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

function payloadOf(result: ToolExecutionResult): Record<string, any> {
  return JSON.parse(textOf(result)) as Record<string, any>;
}

describe('resource tool definitions', () => {
  const servers = [serverState('filesystem')];
  const access = stubAccess();

  it('uses the exact mcp__resources__ names the visibility branch matches on', () => {
    const definitions = createResourceToolDefinitions({
      manager: stubManager(servers),
      resources: access,
      offload: { writeSpill: () => ({ refPath: 'spill/x.md', absPath: '/tmp/x.md' }) },
    });

    expect(definitions.map((definition) => definition.name)).toEqual([
      'mcp__resources__list',
      'mcp__resources__list_templates',
      'mcp__resources__read',
    ]);
    expect(MCP_RESOURCE_TOOL_NAMES).toEqual([
      MCP_RESOURCES_LIST_TOOL_NAME,
      MCP_RESOURCES_LIST_TEMPLATES_TOOL_NAME,
      MCP_RESOURCES_READ_TOOL_NAME,
    ]);
    for (const definition of definitions) {
      expect(definition.name.startsWith('mcp__')).toBe(true);
      expect(serverNameOfMcpTool(definition.name)).toBe(MCP_RESERVED_SERVER);
      expect(definition.category).toBe('mcp');
      expect(definition.deferrable).toBe(true);
      expect(definition.capability).toEqual(mcpResourceToolCapability);
    }
  });

  it('declares a read-only, approval-free mcp capability', () => {
    expect(mcpResourceToolCapability).toEqual({
      category: 'mcp',
      readOnly: true,
      readsFiles: false,
      writesFiles: false,
      usesShell: false,
      usesNetwork: true,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'none',
    });
  });

  it('is exempt from allow_servers, blockable by deny_servers, never visible when restricted', () => {
    const scope = (profile: 'full' | 'standard' | 'restricted', mcp: any) =>
      toMcpVisibilityScope(profile, mcp);

    for (const name of MCP_RESOURCE_TOOL_NAMES) {
      expect(isMcpToolVisible(name, scope('standard', { allowServers: ['filesystem'] }))).toBe(
        true,
      );
      expect(isMcpToolVisible(name, scope('standard', { allowServers: [] }))).toBe(true);
      expect(isMcpToolVisible(name, scope('standard', { denyServers: ['resources'] }))).toBe(false);
      expect(isMcpToolVisible(name, scope('restricted', { allowServers: ['resources'] }))).toBe(
        false,
      );
    }
  });

  it('registers only while a connected server declares the resources capability', () => {
    expect(shouldRegisterResourceTools(stubManager([serverState('filesystem')]))).toBe(true);
    expect(
      shouldRegisterResourceTools(stubManager([serverState('fs2', { state: 'disconnected' })])),
    ).toBe(false);
    expect(
      shouldRegisterResourceTools(stubManager([serverState('fs3', { supportsResources: false })])),
    ).toBe(false);
    expect(shouldRegisterResourceTools(stubManager([]))).toBe(false);
  });
});

describe('resource tools', () => {
  let baseDir: string;
  let offload: OffloadStore;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'mcp-resources-'));
    offload = new OffloadStore(baseDir);
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  function build(manager: McpManager, resources: McpResourceAccess, context = ctx()) {
    const definitions = createResourceToolDefinitions({ manager, resources, offload });
    const byName = new Map(definitions.map((definition) => [definition.name, definition]));
    return {
      list: (args: any) => byName.get(MCP_RESOURCES_LIST_TOOL_NAME)!.execute(args, context),
      listTemplates: (args: any) =>
        byName.get(MCP_RESOURCES_LIST_TEMPLATES_TOOL_NAME)!.execute(args, context),
      read: (args: any) => byName.get(MCP_RESOURCES_READ_TOOL_NAME)!.execute(args, context),
    };
  }

  it('aggregates every resource-capable server and tags each entry', async () => {
    const access = stubAccess({
      listResources: vi.fn(async (server: string) => ({
        resources: [{ uri: `file:///${server}.txt`, name: `${server}.txt` }],
      })),
    });
    const tools = build(
      stubManager([
        serverState('filesystem'),
        serverState('github'),
        serverState('quiet', { supportsResources: false }),
      ]),
      access,
    );

    const result = await tools.list({});

    expect(result.isError).toBeFalsy();
    expect(payloadOf(result)).toEqual({
      resources: [
        { uri: 'file:///filesystem.txt', name: 'filesystem.txt', server: 'filesystem' },
        { uri: 'file:///github.txt', name: 'github.txt', server: 'github' },
      ],
    });
    expect(access.listResources).toHaveBeenCalledTimes(2);
  });

  it('forwards the caller abort signal so a long read can be cancelled', async () => {
    const controller = new AbortController();
    const access = stubAccess({
      listResources: vi.fn(async () => ({ resources: [] })),
      readResource: vi.fn(async () => ({
        contents: [{ uri: 'file:///a.txt', mimeType: 'text/plain', text: 'hi' }],
      })),
    });
    const tools = build(stubManager([serverState('filesystem')]), access, {
      ...ctx(),
      signal: controller.signal,
    });

    await tools.list({ server: 'filesystem' });
    await tools.read({ server: 'filesystem', uri: 'file:///a.txt' });

    expect(access.listResources).toHaveBeenCalledWith('filesystem', undefined, {
      signal: controller.signal,
    });
    expect(access.readResource).toHaveBeenCalledWith('filesystem', 'file:///a.txt', {
      signal: controller.signal,
    });
  });

  it('pins one server and forwards the cursor', async () => {
    const access = stubAccess({
      listResources: vi.fn(async () => ({
        resources: [{ uri: 'file:///a.txt', name: 'a.txt' }],
        nextCursor: 'page-2',
      })),
    });
    const tools = build(stubManager([serverState('filesystem')]), access);

    const result = await tools.list({ server: 'filesystem', cursor: 'page-1' });

    expect(access.listResources).toHaveBeenCalledWith('filesystem', 'page-1', undefined);
    expect(payloadOf(result)).toEqual({
      server: 'filesystem',
      resources: [{ uri: 'file:///a.txt', name: 'a.txt', server: 'filesystem' }],
      nextCursor: 'page-2',
    });
  });

  it('skips ui:// resources and MCP App mime types', async () => {
    const access = stubAccess({
      listResources: vi.fn(async () => ({
        resources: [
          { uri: 'ui://widget/main', name: 'app' },
          { uri: 'file:///app.html', name: 'app-html', mimeType: 'text/html;profile=mcp-app' },
          { uri: 'file:///keep.txt', name: 'keep', mimeType: 'text/plain' },
        ],
      })),
      listResourceTemplates: vi.fn(async () => ({
        resourceTemplates: [
          { uriTemplate: 'ui://widget/{id}', name: 'app-template' },
          { uriTemplate: 'file:///{path}', name: 'file-template' },
        ],
      })),
    });
    const tools = build(stubManager([serverState('filesystem')]), access);

    expect(payloadOf(await tools.list({})).resources).toEqual([
      { uri: 'file:///keep.txt', name: 'keep', mimeType: 'text/plain', server: 'filesystem' },
    ]);
    expect(payloadOf(await tools.listTemplates({})).resourceTemplates).toEqual([
      { uriTemplate: 'file:///{path}', name: 'file-template', server: 'filesystem' },
    ]);
  });

  it('rejects a cursor without a server instead of silently ignoring it', async () => {
    const access = stubAccess();
    const tools = build(stubManager([serverState('filesystem')]), access);

    const result = await tools.list({ cursor: 'page-1' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('cursor');
    expect(access.listResources).not.toHaveBeenCalled();
  });

  it('explains an unknown server, a non-resource server and an empty fleet', async () => {
    const access = stubAccess();
    const tools = build(
      stubManager([serverState('filesystem'), serverState('plain', { supportsResources: false })]),
      access,
    );

    expect(textOf(await tools.list({ server: 'nope' }))).toContain('Unknown MCP server');
    expect(textOf(await tools.list({ server: 'plain' }))).toContain(
      'does not declare the resources capability',
    );
    expect(textOf(await build(stubManager([]), access).list({}))).toContain(
      'No connected MCP server declares the resources capability',
    );
  });

  it('keeps a partial listing successful but marks a total failure as an error', async () => {
    const access = stubAccess({
      listResources: vi.fn(async (server: string) => {
        if (server === 'broken') throw new Error('boom');
        return { resources: [{ uri: 'file:///ok.txt', name: 'ok.txt' }] };
      }),
    });
    const tools = build(stubManager([serverState('filesystem'), serverState('broken')]), access);

    const partial = await tools.list({});
    expect(partial.isError).toBeFalsy();
    expect(payloadOf(partial).errors).toEqual([{ server: 'broken', error: 'boom' }]);

    const allBroken = await build(stubManager([serverState('broken')]), access).list({});
    expect(allBroken.isError).toBe(true);
    expect(textOf(allBroken)).toContain('boom');
  });

  it('retries a resource read once on 5xx but not on 4xx', async () => {
    const listResources = vi
      .fn()
      .mockRejectedValueOnce(new McpHttpError(503, 'unavailable'))
      .mockResolvedValueOnce({ resources: [{ uri: 'file:///ok.txt', name: 'ok.txt' }] });
    const tools = build(stubManager([serverState('filesystem')]), stubAccess({ listResources }));

    expect((await tools.list({})).isError).toBeFalsy();
    expect(listResources).toHaveBeenCalledTimes(2);

    const rejected = vi.fn().mockRejectedValue(new McpHttpError(404, 'not found'));
    const broken = await build(
      stubManager([serverState('filesystem')]),
      stubAccess({ listResources: rejected }),
    ).list({});

    expect(broken.isError).toBe(true);
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it('reads text, images and binary resources through readResource, never toLlmContent', async () => {
    const readResource = vi.fn(async () => ({
      contents: [
        { uri: 'file:///notes.txt', mimeType: 'text/plain', text: 'hello' },
        { uri: 'file:///chart.png', mimeType: 'image/png', blob: 'aGVsbG8=' },
        { uri: 'file:///report.pdf', mimeType: 'application/pdf', blob: 'cGRm' },
        { uri: 'file:///app.html', mimeType: 'text/html; profile=mcp-app', text: '<html>' },
      ],
    }));
    const tools = build(stubManager([serverState('filesystem')]), stubAccess({ readResource }));

    const result = await tools.read({ server: 'filesystem', uri: 'file:///report.pdf' });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      { type: 'text', text: 'Resource "file:///report.pdf" from "filesystem":' },
      { type: 'text', text: 'hello' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      expect.objectContaining({ type: 'text' }),
    ]);

    const spillBlock = result.content[3] as { text: string };
    const spillPath = spillBlock.text.match(/ to (.+\.md)$/)?.[1];
    expect(spillPath).toBeTruthy();
    expect(spillBlock.text).toContain('application/pdf');
    expect(spillBlock.text).toContain('3 bytes');
    // The spilled file is the byte-exact base64 payload.
    expect(readFileSync(spillPath!, 'utf-8')).toBe('cGRm');
    expect(readResource).toHaveBeenCalledWith('filesystem', 'file:///report.pdf', undefined);
  });

  it('refuses MCP App resources', async () => {
    const readResource = vi.fn(async () => ({
      contents: [{ uri: 'file:///app.html', mimeType: 'text/html;profile=mcp-app', text: 'x' }],
    }));
    const tools = build(stubManager([serverState('filesystem')]), stubAccess({ readResource }));

    expect((await tools.read({ server: 'filesystem', uri: 'ui://app/main' })).isError).toBe(true);
    expect(readResource).not.toHaveBeenCalled();

    const appOnly = await tools.read({ server: 'filesystem', uri: 'file:///app.html' });
    expect(appOnly.isError).toBe(true);
    expect(textOf(appOnly)).toContain('MCP App');
  });

  it('reports a failed resource read without throwing', async () => {
    const readResource = vi.fn(async () => {
      throw new McpHttpError(401, 'unauthorized');
    });
    const tools = build(stubManager([serverState('filesystem')]), stubAccess({ readResource }));

    const result = await tools.read({ server: 'filesystem', uri: 'file:///secret.txt' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('unauthorized');
    expect(readResource).toHaveBeenCalledTimes(1);
  });

  it('requires both server and uri', async () => {
    const access = stubAccess();
    const tools = build(stubManager([serverState('filesystem')]), access);

    expect((await tools.read({ server: '', uri: 'file:///a' })).isError).toBe(true);
    expect((await tools.read({ server: 'filesystem', uri: '' })).isError).toBe(true);
    expect(access.readResource).not.toHaveBeenCalled();
  });
});
