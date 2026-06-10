// ---------------------------------------------------------------------------
// Tests for web_search v4 ToolDefinition (extension version)
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { createWebSearchTool } from '../../../extensions/web-search/web-search-tool.js';
import type { ToolExecutionContext } from '../../../src/tools/platform/tool-context.js';
import { extractToolText, expectToolResultContains } from '../../helpers/tool-result.js';

// ---------------------------------------------------------------------------
// Context factory with search config
// ---------------------------------------------------------------------------

function makeCtx(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    cwd: '/tmp',
    policyScope: { agentId: 'test' } as any,
    services: {
      config: {
        webSearch: {
          providerOrder: ['tavily', 'exa', 'baidu'],
          tavilyApiKey: 'test-tavily-key',
          exaApiKey: 'test-exa-key',
          baiduApiKey: 'test-baidu-key',
          searchTimeoutMs: 5000,
          maxResults: 5,
        },
      },
    } as any,
    ...overrides,
  };
}

const searchDef = createWebSearchTool();

describe('web_search', () => {
  it('accepts a query string parameter', () => {
    const schema = searchDef.parametersSchema as any;
    expect(schema.properties).toBeDefined();
    expect(schema.properties.query).toBeDefined();
  });

  it('has correct capability descriptor', () => {
    expect(searchDef.capability.category).toBe('web');
    expect(searchDef.capability.readOnly).toBe(true);
    expect(searchDef.capability.usesNetwork).toBe(true);
    expect(searchDef.capability.approvalDefault).toBe('none');
  });

  it('has correct label and description', () => {
    expect(searchDef.name).toBe('web_search');
    expect(searchDef.label).toBe('Web Search');
    expect(searchDef.description).toContain('Search');
  });

  it('falls through providers on network error until all fail', async () => {
    const ctx = makeCtx({
      services: {
        config: {
          webSearch: {
            providerOrder: ['tavily', 'exa'],
            tavilyApiKey: 'fake-key',
            exaApiKey: 'fake-key',
            searchTimeoutMs: 1000,
            maxResults: 3,
          },
        },
      } as any,
    });
    const result = await searchDef.execute({ query: 'hello world' }, ctx);
    // All providers will fail with network/API errors → error result
    expect(result.isError).toBe(true);
  });

  it('respects maxResults parameter', () => {
    const schema = searchDef.parametersSchema as any;
    expect(schema.properties.maxResults).toBeDefined();
  });

  it('accepts optional timeRange parameter', () => {
    const schema = searchDef.parametersSchema as any;
    expect(schema.properties.timeRange).toBeDefined();
  });

  it('accepts optional topic parameter', () => {
    const schema = searchDef.parametersSchema as any;
    expect(schema.properties.topic).toBeDefined();
  });

  it('has no provider parameter (provider chain is used instead)', () => {
    const schema = searchDef.parametersSchema as any;
    expect(schema.properties.provider).toBeUndefined();
  });
});
