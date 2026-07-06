import { Type } from 'typebox';
import type { ToolDefinition } from '../../src/tools/platform/tool-definition.js';
import type { ToolExecutionContext } from '../../src/tools/platform/tool-context.js';
import type { ToolCapabilityDescriptor } from '../../src/tools/platform/tool-capabilities.js';
import { textResult, errorResult } from '../../src/tools/platform/tool-result.js';
import { i18n } from '../../src/i18n/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SearchParams {
  query: string;
  maxResults: number;
  timeRange?: 'day' | 'week' | 'month' | 'year';
  topic?: 'general' | 'news';
}

interface SearchResultItem {
  title: string;
  url: string;
  content: string;
  score?: number;
  publishedDate?: string;
}

interface SearchResult {
  query: string;
  results: SearchResultItem[];
  provider: string;
  responseTimeMs: number;
}

interface SearchProvider {
  name: string;
  search(params: SearchParams, timeoutMs: number, signal?: AbortSignal, logger?: { warn: (...args: any[]) => void; info: (...args: any[]) => void }): Promise<SearchResult>;
}

// Options are read from ctx.services.config.webSearch at execution time.
// The only constructor param is the config object for convenience at registration time.
export interface WebSearchToolOptions {
  providerOrder: string[];
  tavilyApiKey?: string;
  exaApiKey?: string;
  baiduApiKey?: string;
  anysearchApiKey?: string;
  timeoutMs?: number;
  defaultMaxResults?: number;
}

export const webSearchToolCapability: ToolCapabilityDescriptor = {
  category: 'web' as const,
  readOnly: true,
  readsFiles: false,
  writesFiles: false,
  usesShell: false,
  usesNetwork: true,
  usesComputerUse: false,
  pathAccess: 'none' as const,
  approvalDefault: 'none' as const,
};

// ---------------------------------------------------------------------------
// Tavily Provider
// ---------------------------------------------------------------------------

class TavilyProvider implements SearchProvider {
  name = 'Tavily';

  constructor(private apiKey: string) {}

  async search(params: SearchParams, timeoutMs: number, signal?: AbortSignal, _logger?: unknown): Promise<SearchResult> {
    const startedAt = Date.now();

    const body: Record<string, unknown> = {
      query: params.query,
      max_results: params.maxResults,
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false,
    };
    if (params.timeRange) body.time_range = params.timeRange;
    if (params.topic) body.topic = params.topic;

    const resp = await fetchWithTimeout('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    }, timeoutMs);

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Tavily returned ${resp.status}: ${text.slice(0, 200)}`);
    }

    const data = await resp.json() as TavilyResponse;

    return {
      query: data.query,
      provider: 'Tavily',
      responseTimeMs: Date.now() - startedAt,
      results: (data.results ?? []).map(r => ({
        title: r.title,
        url: r.url,
        content: r.content,
        score: r.score,
        publishedDate: r.published_date,
      })),
    };
  }
}

interface TavilyResponse {
  query: string;
  results?: Array<{
    title: string;
    url: string;
    content: string;
    score?: number;
    published_date?: string;
  }>;
  response_time?: number;
}

// ---------------------------------------------------------------------------
// Exa Provider
// ---------------------------------------------------------------------------

const EXA_MCP_ENDPOINT = 'https://mcp.exa.ai/mcp';
const MCP_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
};

class ExaProvider implements SearchProvider {
  name = 'Exa';

  constructor(private apiKey?: string) {}

  async search(params: SearchParams, timeoutMs: number, signal?: AbortSignal, _logger?: unknown): Promise<SearchResult> {
    const startedAt = Date.now();

    if (this.apiKey) {
      return this.searchViaRest(params, timeoutMs, signal, startedAt);
    }
    return this.searchViaMcp(params, timeoutMs, signal, startedAt);
  }

  private async searchViaRest(
    params: SearchParams,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    startedAt: number,
  ): Promise<SearchResult> {
    const body: Record<string, unknown> = {
      query: params.query,
      numResults: params.maxResults,
      type: 'auto',
      contents: { text: { maxCharacters: 500 } },
    };
    if (params.timeRange) {
      body.startPublishedDate = timeRangeToExaDate(params.timeRange);
    }

    const resp = await fetchWithTimeout('https://api.exa.ai/search', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    }, timeoutMs);

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Exa returned ${resp.status}: ${text.slice(0, 200)}`);
    }

    const data = await resp.json() as ExaResponse;

    return {
      query: data.query ?? params.query,
      provider: 'Exa',
      responseTimeMs: Date.now() - startedAt,
      results: (data.results ?? []).map(r => ({
        title: r.title ?? '',
        url: r.url,
        content: r.text ?? '',
        score: r.score,
        publishedDate: r.publishedDate,
      })),
    };
  }

  private async searchViaMcp(
    params: SearchParams,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    startedAt: number,
  ): Promise<SearchResult> {
    const result = await mcpCallTool('web_search_exa', {
      query: params.query,
      numResults: params.maxResults,
    }, timeoutMs, signal);

    const text = mcpExtractText(result);
    const results = parseExaTextResults(text);

    return {
      query: params.query,
      provider: 'Exa',
      responseTimeMs: Date.now() - startedAt,
      results,
    };
  }
}

function timeRangeToExaDate(range: string): string {
  const offsets: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
  const days = offsets[range] ?? 7;
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

interface ExaResponse {
  query?: string;
  results?: Array<{
    title?: string;
    url: string;
    text?: string;
    score?: number;
    publishedDate?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Baidu Provider
// ---------------------------------------------------------------------------

class BaiduProvider implements SearchProvider {
  name = 'Baidu';

  constructor(private apiKey: string) {}

  async search(params: SearchParams, timeoutMs: number, signal?: AbortSignal, _logger?: unknown): Promise<SearchResult> {
    const startedAt = Date.now();

    const body: Record<string, unknown> = {
      messages: [{ role: 'user', content: params.query }],
      search_mode: 'required',
      search_recency_filter: baiduTimeRange(params.timeRange),
      stream: false,
    };

    const resp = await fetchWithTimeout(
      'https://qianfan.baidubce.com/v2/ai_search/chat/completions',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      },
      timeoutMs,
    );

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Baidu returned ${resp.status}: ${text.slice(0, 200)}`);
    }

    const data = await resp.json() as BaiduResponse;

    return {
      query: params.query,
      provider: 'Baidu',
      responseTimeMs: Date.now() - startedAt,
      results: (data.references ?? []).map(r => ({
        title: r.title ?? '',
        url: r.url ?? '',
        content: r.content ?? '',
        score: r.score,
        publishedDate: r.date,
      })),
    };
  }
}

function baiduTimeRange(range?: string): string | undefined {
  if (!range) return undefined;
  const map: Record<string, string> = { day: 'day', week: 'week', month: 'month', year: 'year' };
  return map[range];
}

interface BaiduResponse {
  references?: Array<{
    title?: string;
    url?: string;
    content?: string;
    score?: number;
    date?: string;
  }>;
}

// ---------------------------------------------------------------------------
// AnySearch Provider
// ---------------------------------------------------------------------------

// Fallback from authenticated to anonymous mode when:
// 401: invalid_api_key / invalid_auth_header (key invalid/missing)
// 402: quota_exhausted / user_daily_quota_exhausted (authenticated quota drained, anonymous quota is separate)
// 403: expired_api_key / private_capability_not_enabled / account_disabled (key permission/status issues)
// 429: rate_limit_exceeded_user / rate_limit_exceeded (per-key or account-level rate limit hit)
//
// Not included (no point falling back — anonymous won't help):
// 400: request validation errors; 415: extract content-type; 5xx: server-side failures
const ANYSEARCH_AUTH_FAIL_CODES = new Set([401, 402, 403, 429]);

class AnySearchProvider implements SearchProvider {
  name = 'AnySearch';

  constructor(private apiKey?: string) {}

  async search(params: SearchParams, timeoutMs: number, signal?: AbortSignal, logger?: { warn: (...args: any[]) => void }): Promise<SearchResult> {
    const startedAt = Date.now();

    if (this.apiKey) {
      try {
        return await this.doSearch(params, timeoutMs, signal, startedAt, this.apiKey);
      } catch (err: any) {
        if (err.statusCode && ANYSEARCH_AUTH_FAIL_CODES.has(err.statusCode)) {
          logger?.warn(`[web_search] AnySearch authenticated mode failed (${err.statusCode}), falling back to anonymous mode`);
          return this.doSearch(params, timeoutMs, signal, startedAt, undefined);
        }
        throw err;
      }
    }

    return this.doSearch(params, timeoutMs, signal, startedAt, undefined);
  }

  private async doSearch(
    params: SearchParams,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    startedAt: number,
    apiKey: string | undefined,
  ): Promise<SearchResult> {
    const body: Record<string, unknown> = {
      query: params.query,
      max_results: params.maxResults,
    };
    if (params.timeRange) {
      body.constraint = { freshness: params.timeRange };
    }
    if (params.topic === 'news') {
      body.content_types = ['news'];
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const resp = await fetchWithTimeout('https://api.anysearch.com/v1/search', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    }, timeoutMs);

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      const err = new Error(`AnySearch returned ${resp.status}: ${text.slice(0, 200)}`) as any;
      err.statusCode = resp.status;
      throw err;
    }

    const raw = await resp.json() as any;
    // AnySearch wraps responses in { code, message, data }
    const data = raw.data ?? raw;

    return {
      query: params.query,
      provider: 'AnySearch',
      responseTimeMs: Date.now() - startedAt,
      results: (data.results ?? []).map((r: any) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        content: r.content || r.description || '',
        score: r.quality_score ?? r.score,
        publishedDate: r.published_at,
      })),
    };
  }
}

interface AnySearchResponse {
  results?: Array<{
    title?: string;
    url?: string;
    description?: string;
    content?: string;
    score?: number;
    quality_score?: number;
    published_at?: string;
  }>;
  metadata?: {
    total_results?: number;
    search_time_ms?: number;
  };
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC helpers (stateless — Exa's Vercel deployment)
// ---------------------------------------------------------------------------

async function mcpCallTool(
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const resp = await fetchWithTimeout(EXA_MCP_ENDPOINT, {
    method: 'POST',
    headers: MCP_HEADERS,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
    signal,
  }, timeoutMs);

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Exa MCP returned ${resp.status}: ${body.slice(0, 200)}`);
  }

  const sseText = await resp.text();
  return parseSseResponse(sseText);
}

function parseSseResponse(sseText: string): unknown {
  for (const line of sseText.split('\n')) {
    if (line.startsWith('data: ')) {
      const payload = JSON.parse(line.slice(6));
      if (payload.error) {
        throw new Error(`Exa MCP error: ${payload.error.message ?? JSON.stringify(payload.error)}`);
      }
      return payload.result;
    }
  }
  throw new Error('Exa MCP returned empty SSE response');
}

function mcpExtractText(result: unknown): string {
  const r = result as any;
  return r?.content?.[0]?.text ?? '';
}

// ---------------------------------------------------------------------------
// Parse Exa text results (structured text format)
// ---------------------------------------------------------------------------

function parseExaTextResults(text: string): SearchResultItem[] {
  if (!text) return [];

  const results: SearchResultItem[] = [];
  const blocks = text.split(/\n---\n/).filter(b => b.trim());

  for (const block of blocks) {
    const title = extractField(block, 'Title:');
    const url = extractField(block, 'URL:');

    const highlightsMatch = block.match(/^Highlights:\s*\n(.*)/ms);
    let highlights = highlightsMatch?.[1]?.trim() ?? '';

    if (!highlights) {
      const bodyLines = block.split('\n')
        .filter(l => !l.match(/^(Title:|URL:|Published:|Author:|Highlights:)/))
        .map(l => l.trim())
        .filter(Boolean);
      highlights = bodyLines.join('\n').slice(0, 500);
    }

    if (title || url) {
      results.push({
        title: title ?? url ?? '',
        url: url ?? '',
        content: highlights.slice(0, 500),
        publishedDate: extractField(block, 'Published:'),
      });
    }
  }

  return results;
}

function extractField(text: string, label: string): string | undefined {
  const match = text.match(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(.+)$`, 'm'));
  return match?.[1]?.trim();
}

// ---------------------------------------------------------------------------
// fetchWithTimeout
// ---------------------------------------------------------------------------

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const combinedSignal = init.signal ?? controller.signal;

  if (init.signal) {
    init.signal.addEventListener('abort', () => controller.abort());
  }

  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, { ...init, signal: combinedSignal });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

function buildProviders(opts: WebSearchToolOptions): SearchProvider[] {
  const providers: SearchProvider[] = [];

  for (const id of opts.providerOrder) {
    switch (id) {
      case 'tavily':
        if (opts.tavilyApiKey) {
          providers.push(new TavilyProvider(opts.tavilyApiKey));
        }
        break;
      case 'exa':
        // Exa works without key via public MCP endpoint
        providers.push(new ExaProvider(opts.exaApiKey));
        break;
      case 'baidu':
        if (opts.baiduApiKey) {
          providers.push(new BaiduProvider(opts.baiduApiKey));
        }
        break;
      case 'anysearch':
        providers.push(new AnySearchProvider(opts.anysearchApiKey));
        break;
      default:
        // Unknown providers are silently skipped so users can add
        // experimental/private providers without schema changes
        break;
    }
  }

  // If nothing matched (e.g. only unknown providers), fall back to Exa
  if (providers.length === 0) {
    providers.push(new ExaProvider(opts.exaApiKey));
  }

  return providers;
}

// ---------------------------------------------------------------------------
// Web Search Tool factory
// ---------------------------------------------------------------------------

function formatSearchResult(search: SearchResult): string {
  const lines: string[] = [];
  lines.push(i18n.t('tools-web-search:search.resultHeader', { query: search.query }));
  lines.push('');
  lines.push(i18n.t('tools-web-search:search.providerInfo', { provider: search.provider, ms: search.responseTimeMs }));
  lines.push('');

  if (search.results.length === 0) {
    lines.push(i18n.t('tools-web-search:search.noResults'));
  }

  for (let i = 0; i < search.results.length; i++) {
    const r = search.results[i];
    lines.push(`${i + 1}. **${r.title}**`);
    lines.push(`   URL: ${r.url}`);
    lines.push(`   ${r.content}`);
    const meta: string[] = [];
    if (r.score != null) meta.push(`${i18n.t('tools-web-search:search.scoreLabel')} ${r.score.toFixed(2)}`);
    if (r.publishedDate) meta.push(`${i18n.t('tools-web-search:search.dateLabel')} ${r.publishedDate}`);
    if (meta.length > 0) lines.push(`   _${meta.join(' | ')}_`);
    lines.push('');
  }

  return lines.join('\n');
}

export function createWebSearchTool(options?: WebSearchToolOptions): ToolDefinition<{ query: string; maxResults?: number; timeRange?: string; topic?: string }> {
  const defaults = {
    providerOrder: options?.providerOrder ?? ['tavily', 'exa', 'baidu'],
    timeoutMs: options?.timeoutMs ?? 30000,
    defaultMaxResults: options?.defaultMaxResults ?? 5,
  };

  return {
    name: 'web_search',
    label: 'Web Search',
    description:
      'Search the web for real-time news, facts, current events, or documentation.',
    category: 'web',
    parametersSchema: Type.Object({
      query: Type.String({ description: 'The search query string' }),
      maxResults: Type.Optional(
        Type.Number({ description: 'Maximum number of results to return (1-10)', default: defaults.defaultMaxResults, minimum: 1, maximum: 10 }),
      ),
      timeRange: Type.Optional(
        Type.String({ description: 'Limit results to a time range: day, week, month, or year' }),
      ),
      topic: Type.Optional(
        Type.String({ description: 'Search topic: general (default) or news' }),
      ),
    }),
    capability: webSearchToolCapability,
    execute: async (args, ctx) => {
      const log = ctx.services.logger;
      const wsConfig = ctx.services.config.webSearch;
      const timeoutMs = wsConfig.searchTimeoutMs ?? defaults.timeoutMs;
      const providers = buildProviders({
        providerOrder: wsConfig.providerOrder.length > 0 ? wsConfig.providerOrder : defaults.providerOrder,
        tavilyApiKey: wsConfig.tavilyApiKey,
        exaApiKey: wsConfig.exaApiKey,
        baiduApiKey: wsConfig.baiduApiKey,
        anysearchApiKey: wsConfig.anysearchApiKey,
        timeoutMs,
      });

      const searchParams: SearchParams = {
        query: args.query,
        maxResults: Math.min(args.maxResults ?? defaults.defaultMaxResults, 10),
        timeRange: args.timeRange as SearchParams['timeRange'],
        topic: args.topic as SearchParams['topic'],
      };

      // Internal timeout via AbortController
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const errors: string[] = [];

      try {
        for (const provider of providers) {
          try {
            const result = await provider.search(searchParams, timeoutMs, controller.signal, log);

            if (result.results.length === 0 && provider !== providers[providers.length - 1]) {
              log?.warn(`[web_search] ${provider.name} returned empty results, trying next provider`);
              errors.push(`${provider.name}: empty results`);
              continue;
            }

            log?.debug(`[web_search] ${provider.name} succeeded (${result.results.length} results, ${result.responseTimeMs}ms)`);
            return textResult(formatSearchResult(result), result as unknown as Record<string, unknown>);
          } catch (err: any) {
            const msg = err.name === 'AbortError' ? 'timeout' : (err.message ?? String(err));
            errors.push(`${provider.name}: ${msg}`);

            if (controller.signal.aborted) {
              return errorResult(i18n.t('tools-web-search:search.cancelled'));
            }

            if (provider !== providers[providers.length - 1]) {
              log?.warn(`[web_search] ${provider.name} failed (${msg}), trying next provider`);
            }
          }
        }

        return errorResult(i18n.t('tools-web-search:search.allFailed', {
          query: searchParams.query,
          errors: errors.map(e => `- ${e}`).join('\n'),
        }));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
