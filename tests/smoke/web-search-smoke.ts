/**
 * Quick smoke-test for web_search tool.
 * Tests provider chain: reads provider order from env, tests fallback behavior.
 */
import 'dotenv/config';
import { createWebSearchTool } from '../../extensions/web-search/web-search-tool.js';
import type { ToolExecutionContext } from '../../src/tools/platform/tool-context.js';

const providerOrder = (process.env.WEB_SEARCH_PROVIDER || 'tavily,exa').split(',').map(s => s.trim());

const tool = createWebSearchTool();

const ctx: ToolExecutionContext = {
  cwd: '/tmp',
  policyScope: { agentId: 'smoke-test' } as any,
  services: {
    config: {
      webSearch: {
        providerOrder,
        tavilyApiKey: process.env.WEB_SEARCH_TAVILY_API_KEY || undefined,
        exaApiKey: process.env.WEB_SEARCH_EXA_API_KEY || undefined,
        baiduApiKey: process.env.WEB_SEARCH_BAIDU_API_KEY || undefined,
        anysearchApiKey: process.env.WEB_SEARCH_ANYSEARCH_API_KEY || undefined,
        searchTimeoutMs: 15000,
        maxResults: 3,
      },
    },
  } as any,
};

const queries = [
  'TypeScript latest version 2026',
  '飞书最新功能',
];

async function run() {
  console.log('=== Web Search Smoke Test ===');
  console.log(`Provider order: ${providerOrder.join(' → ')}`);
  console.log(`Tavily key: ${process.env.WEB_SEARCH_TAVILY_API_KEY ? 'set' : 'not set'}`);
  console.log(`Exa key: ${process.env.WEB_SEARCH_EXA_API_KEY ? 'set' : 'not set (free MCP)'}`);
  console.log(`Baidu key: ${process.env.WEB_SEARCH_BAIDU_API_KEY ? 'set' : 'not set'}`);
  console.log(`AnySearch key: ${process.env.WEB_SEARCH_ANYSEARCH_API_KEY ? 'set' : 'not set'}`);
  console.log('');

  for (const query of queries) {
    console.log(`--- Query: "${query}" ---`);
    const startedAt = Date.now();
    const result = await tool.execute({ query, maxResults: 3 }, ctx);
    const elapsed = Date.now() - startedAt;
    const text = result.content?.[0]?.text ?? JSON.stringify(result);
    console.log(text.slice(0, 800));
    console.log(`[耗时 ${elapsed}ms, isError: ${result.isError}]`);
    console.log('');
  }

  console.log('=== Done ===');
}

run().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
