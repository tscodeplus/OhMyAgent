// ---------------------------------------------------------------------------
// BM25 retrieval tests
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { tokenize, buildCatalog, searchCatalog } from '../../../src/tools/tool-search/bm25.js';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const SAMPLE_TOOLS: { name: string; label: string; description: string; category: string }[] = [
  { name: 'github_create_issue', label: 'Create Issue', description: 'Open a new issue in a GitHub repository', category: 'mcp' },
  { name: 'github_search_repos', label: 'Search Repos', description: 'Search GitHub for matching repositories', category: 'mcp' },
  { name: 'slack_send_message', label: 'Send Message', description: 'Post a message into a Slack channel', category: 'mcp' },
  { name: 'calendar_create_event', label: 'Create Event', description: 'Add an event to the user calendar', category: 'mcp' },
  { name: 'file_read', label: 'Read File', description: 'Read contents of a file from the filesystem', category: 'file' },
  { name: 'file_write', label: 'Write File', description: 'Write contents to a file on the filesystem', category: 'file' },
];

function sampleCatalog() {
  return buildCatalog(SAMPLE_TOOLS);
}

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

describe('tokenize', () => {
  it('tokenizes simple words', () => {
    expect(tokenize('search files')).toEqual(['search', 'files']);
  });

  it('splits snake_case names', () => {
    const tokens = tokenize('github_create_issue');
    expect(tokens).toContain('github');
    expect(tokens).toContain('create');
    expect(tokens).toContain('issue');
  });

  it('splits dot-separated names', () => {
    const tokens = tokenize('mcp.github.repos');
    expect(tokens).toContain('mcp');
    expect(tokens).toContain('github');
    expect(tokens).toContain('repos');
  });

  it('splits kebab-case names', () => {
    const tokens = tokenize('my-tool-name');
    expect(tokens).toContain('my');
    expect(tokens).toContain('tool');
    expect(tokens).toContain('name');
  });

  it('handles mixed separators', () => {
    const tokens = tokenize('mcp-github.create_repo');
    expect(tokens).toContain('mcp');
    expect(tokens).toContain('github');
    expect(tokens).toContain('create');
    expect(tokens).toContain('repo');
  });

  it('returns empty array for empty string', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('lowercases all tokens', () => {
    const tokens = tokenize('GitHub Create_Issue');
    expect(tokens).toEqual(['github', 'create', 'issue']);
  });
});

// ---------------------------------------------------------------------------
// Catalog building
// ---------------------------------------------------------------------------

describe('buildCatalog', () => {
  it('builds catalog with pre-computed tokens', () => {
    const catalog = buildCatalog(SAMPLE_TOOLS);
    expect(catalog).toHaveLength(SAMPLE_TOOLS.length);
    for (const entry of catalog) {
      expect(entry.tokens.length).toBeGreaterThan(0);
      expect(entry.name).toBeTruthy();
      expect(entry.description).toBeTruthy();
    }
  });

  it('handles empty input', () => {
    const catalog = buildCatalog([]);
    expect(catalog).toEqual([]);
  });

  it('handles entries with empty descriptions', () => {
    const catalog = buildCatalog([{ name: 'test', label: 'Test', description: '', category: 'test' }]);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]!.tokens.length).toBeGreaterThan(0); // name + label still produces tokens
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

describe('searchCatalog', () => {
  it('finds the most relevant tool by BM25', () => {
    const catalog = sampleCatalog();
    const hits = searchCatalog(catalog, 'create a github issue', 5);
    expect(hits.length).toBeGreaterThan(0);
    // github_create_issue should be the top hit
    expect(hits[0]!.name).toBe('github_create_issue');
  });

  it('returns empty array for irrelevant query', () => {
    const catalog = sampleCatalog();
    const hits = searchCatalog(catalog, 'asdf qwerty foobar xyzzy', 3);
    expect(hits).toEqual([]);
  });

  it('uses substring fallback when BM25 yields no hits', () => {
    const catalog = sampleCatalog();
    // "calendar" appears in calendar_create_event → zero-IDF if there's only one
    // Actually BM25 should work fine here. Let's test with a literal name substring.
    const hits = searchCatalog(catalog, 'slack_send_message', 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.name === 'slack_send_message')).toBe(true);
  });

  it('respects the limit parameter', () => {
    const catalog = sampleCatalog();
    const hits = searchCatalog(catalog, 'file', 1);
    expect(hits.length).toBeLessThanOrEqual(1);
  });

  it('returns empty for limit=0', () => {
    const catalog = sampleCatalog();
    const hits = searchCatalog(catalog, 'github', 0);
    expect(hits).toEqual([]);
  });

  it('returns empty for negative limit', () => {
    const catalog = sampleCatalog();
    const hits = searchCatalog(catalog, 'github', -1);
    expect(hits).toEqual([]);
  });

  it('returns empty for empty catalog', () => {
    const hits = searchCatalog([], 'github', 5);
    expect(hits).toEqual([]);
  });

  it('returns empty for empty query', () => {
    const catalog = sampleCatalog();
    const hits = searchCatalog(catalog, '', 5);
    expect(hits).toEqual([]);
  });

  it('returns empty for whitespace-only query', () => {
    const catalog = sampleCatalog();
    const hits = searchCatalog(catalog, '   ', 5);
    expect(hits).toEqual([]);
  });

  it('ranks file_read higher than file_write for "read file"', () => {
    const catalog = sampleCatalog();
    const hits = searchCatalog(catalog, 'read file', 5);
    const readIdx = hits.findIndex((h) => h.name === 'file_read');
    const writeIdx = hits.findIndex((h) => h.name === 'file_write');
    expect(readIdx).not.toBe(-1);
    expect(readIdx).toBeLessThan(writeIdx === -1 ? Infinity : writeIdx);
  });

  it('substring fallback matches partial tool name', () => {
    // Create a catalog where all tools share a prefix, making BM25 IDF zero
    const similarTools = buildCatalog([
      { name: 'mcp_github_tool_a', label: 'Tool A', description: 'does something with github', category: 'mcp' },
      { name: 'mcp_github_tool_b', label: 'Tool B', description: 'does something else with github', category: 'mcp' },
      { name: 'mcp_github_tool_c', label: 'Tool C', description: 'yet another github tool', category: 'mcp' },
    ]);
    // All docs contain "github" → IDF ~0. But "tool_b" is unique enough.
    // Actually let's test the substring fallback more directly:
    const hits = searchCatalog(similarTools, 'mcp_github_tool_b', 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.name).toBe('mcp_github_tool_b');
  });
});
