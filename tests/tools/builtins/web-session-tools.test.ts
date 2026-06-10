// ---------------------------------------------------------------------------
// Tests for web_fetch and tool_search v4 ToolDefinition tools
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { createWebFetchToolDefinition } from '../../../src/tools/builtins/web/fetch-definition.js';
import { createToolSearchToolDefinition } from '../../../src/tools/builtins/session/tool-search-definition.js';
import type { ToolExecutionContext } from '../../../src/tools/platform/tool-context.js';
import type { ToolPlatformRegistry } from '../../../src/tools/platform/registry.js';
import type { ToolDefinition } from '../../../src/tools/platform/tool-definition.js';
import { extractToolText, expectToolResultContains } from '../../helpers/tool-result.js';

// ---------------------------------------------------------------------------
// web_fetch
// ---------------------------------------------------------------------------

const webFetchDef = createWebFetchToolDefinition();

describe('web_fetch', () => {
  it('rejects an invalid URL', async () => {
    const result = await webFetchDef.execute(
      { url: 'not-a-url' },
      {} as ToolExecutionContext,
    );
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'Invalid URL');
  });

  it('rejects non-http/https protocol', async () => {
    const result = await webFetchDef.execute(
      { url: 'ftp://example.com/file.txt' },
      {} as ToolExecutionContext,
    );
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'Unsupported protocol');
  });

  it('rejects localhost hostname', async () => {
    const result = await webFetchDef.execute(
      { url: 'http://localhost:8080/test' },
      {} as ToolExecutionContext,
    );
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'internal hostname');
  });

  it('rejects .local hostname', async () => {
    const result = await webFetchDef.execute(
      { url: 'http://myrouter.local/admin' },
      {} as ToolExecutionContext,
    );
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'internal hostname');
  });

  it('rejects 127.0.0.1', async () => {
    const result = await webFetchDef.execute(
      { url: 'http://127.0.0.1/' },
      {} as ToolExecutionContext,
    );
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'internal hostname');
  });

  it('rejects IPv6 loopback addresses', async () => {
    const result = await webFetchDef.execute(
      { url: 'http://[::1]/' },
      {} as ToolExecutionContext,
    );
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'internal hostname');
  });
});

// ---------------------------------------------------------------------------
// tool_search
// ---------------------------------------------------------------------------

const toolSearchDef = createToolSearchToolDefinition();

/**
 * Minimal mock registry for testing tool_search formatting.
 */
function createMockRegistry(
  defs: ToolDefinition[],
): ToolPlatformRegistry {
  return {
    registerDefinition: () => undefined,
    getDefinition: () => undefined,
    listDefinitions: () => defs,
    getByCategory: () => [],
    getAgentTool: () => undefined,
    listAgentTools: () => [],
    has: () => false,
    unregister: () => undefined,
    names: () => [],
    listVisible: () => defs,
    listVisibleNames: () => [],
  };
}

describe('tool_search', () => {
  it('returns error when registry is not available', async () => {
    const ctx: ToolExecutionContext = {
      cwd: '/tmp',
      policyScope: { agentId: 'test' } as any,
      services: {} as any,
    };
    const result = await toolSearchDef.execute({}, ctx);
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'not available');
  });

  it('lists all tools when no filters are applied', async () => {
    const mockTools: ToolDefinition[] = [
      {
        name: 'file_read',
        label: 'File Read',
        description: 'Read file contents',
        category: 'file',
        parametersSchema: {},
        capability: {
          category: 'file',
          readOnly: true,
          readsFiles: true,
          writesFiles: false,
          usesShell: false,
          usesNetwork: false,
          usesComputerUse: false,
          pathAccess: 'read',
          approvalDefault: 'none',
        },
        execute: async () => ({ content: [] }),
      },
      {
        name: 'shell_exec',
        label: 'Shell Exec',
        description: 'Execute shell commands',
        category: 'shell',
        parametersSchema: {},
        capability: {
          category: 'shell',
          readOnly: false,
          readsFiles: false,
          writesFiles: false,
          usesShell: true,
          usesNetwork: false,
          usesComputerUse: false,
          pathAccess: 'none',
          approvalDefault: 'mutating',
        },
        execute: async () => ({ content: [] }),
      },
    ];

    const ctx: ToolExecutionContext = {
      cwd: '/tmp',
      policyScope: { agentId: 'test' } as any,
      services: {
        toolPlatformRegistry: createMockRegistry(mockTools),
      } as any,
    };

    const result = await toolSearchDef.execute({}, ctx);
    expect(result.isError).toBeFalsy();

    const text = extractToolText(result);
    expect(text).toContain('file_read');
    expect(text).toContain('shell_exec');
    expect(text).toContain('readOnly: yes');
    expect(text).toContain('readOnly: no');
  });

  it('filters by category', async () => {
    const mockTools: ToolDefinition[] = [
      {
        name: 'file_read',
        label: 'File Read',
        description: 'Read file contents',
        category: 'file',
        parametersSchema: {},
        capability: {
          category: 'file',
          readOnly: true,
          readsFiles: true,
          writesFiles: false,
          usesShell: false,
          usesNetwork: false,
          usesComputerUse: false,
          pathAccess: 'read',
          approvalDefault: 'none',
        },
        execute: async () => ({ content: [] }),
      },
      {
        name: 'shell_exec',
        label: 'Shell Exec',
        description: 'Execute shell commands',
        category: 'shell',
        parametersSchema: {},
        capability: {
          category: 'shell',
          readOnly: false,
          readsFiles: false,
          writesFiles: false,
          usesShell: true,
          usesNetwork: false,
          usesComputerUse: false,
          pathAccess: 'none',
          approvalDefault: 'mutating',
        },
        execute: async () => ({ content: [] }),
      },
    ];

    const ctx: ToolExecutionContext = {
      cwd: '/tmp',
      policyScope: { agentId: 'test' } as any,
      services: {
        toolPlatformRegistry: createMockRegistry(mockTools),
      } as any,
    };

    const result = await toolSearchDef.execute({ category: 'file' }, ctx);
    expect(result.isError).toBeFalsy();

    const text = extractToolText(result);
    expect(text).toContain('file_read');
    expect(text).not.toContain('shell_exec');
  });

  it('filters by query substring', async () => {
    const mockTools: ToolDefinition[] = [
      {
        name: 'file_read',
        label: 'File Read',
        description: 'Read file contents from disk',
        category: 'file',
        parametersSchema: {},
        capability: {
          category: 'file',
          readOnly: true,
          readsFiles: true,
          writesFiles: false,
          usesShell: false,
          usesNetwork: false,
          usesComputerUse: false,
          pathAccess: 'read',
          approvalDefault: 'none',
        },
        execute: async () => ({ content: [] }),
      },
      {
        name: 'shell_exec',
        label: 'Shell Exec',
        description: 'Execute shell commands',
        category: 'shell',
        parametersSchema: {},
        capability: {
          category: 'shell',
          readOnly: false,
          readsFiles: false,
          writesFiles: false,
          usesShell: true,
          usesNetwork: false,
          usesComputerUse: false,
          pathAccess: 'none',
          approvalDefault: 'mutating',
        },
        execute: async () => ({ content: [] }),
      },
    ];

    const ctx: ToolExecutionContext = {
      cwd: '/tmp',
      policyScope: { agentId: 'test' } as any,
      services: {
        toolPlatformRegistry: createMockRegistry(mockTools),
      } as any,
    };

    const result = await toolSearchDef.execute({ query: 'read' }, ctx);
    expect(result.isError).toBeFalsy();

    const text = extractToolText(result);
    expect(text).toContain('file_read');
    expect(text).not.toContain('shell_exec');
  });

  it('returns "no tools found" when nothing matches', async () => {
    const mockTools: ToolDefinition[] = [
      {
        name: 'file_read',
        label: 'File Read',
        description: 'Read file contents',
        category: 'file',
        parametersSchema: {},
        capability: {
          category: 'file',
          readOnly: true,
          readsFiles: true,
          writesFiles: false,
          usesShell: false,
          usesNetwork: false,
          usesComputerUse: false,
          pathAccess: 'read',
          approvalDefault: 'none',
        },
        execute: async () => ({ content: [] }),
      },
    ];

    const ctx: ToolExecutionContext = {
      cwd: '/tmp',
      policyScope: { agentId: 'test' } as any,
      services: {
        toolPlatformRegistry: createMockRegistry(mockTools),
      } as any,
    };

    const result = await toolSearchDef.execute({ query: 'zzz_nonexistent' }, ctx);
    expect(result.isError).toBeFalsy();
    expectToolResultContains(result, 'No tools found');
  });
});
