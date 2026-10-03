import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OffloadStore } from '../../src/runtime-artifacts/offload-store.js';
import { PromptManager } from '../../src/prompt/prompt-manager.js';
import type { McpPromptServer, PromptManagerDeps } from '../../src/prompt/types.js';

/**
 * Covers the two MCP-integration touch points owned by one change set:
 * `OffloadStore.writeSpill()` (design §6.6 / §19-14) and the `mcp_servers`
 * system-prompt section plus its cache key (design §12.1).
 */

// ── OffloadStore.writeSpill ───────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-spill-test-'));
}

describe('OffloadStore.writeSpill', () => {
  let baseDir: string;
  let store: OffloadStore;

  beforeEach(() => {
    baseDir = createTempDir();
    store = new OffloadStore(baseDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(baseDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  });

  it('writes the text verbatim under <sessionDir>/spill/ and returns both paths', () => {
    const text = 'x'.repeat(50_000);
    const { refPath, absPath } = store.writeSpill('sess-1', 'mcp__filesystem__read_file', text);

    expect(refPath).toBe(path.posix.join('spill', path.basename(absPath)));
    expect(fs.existsSync(absPath)).toBe(true);
    expect(fs.readFileSync(absPath, 'utf-8')).toBe(text);

    const sessionDir = path.join(baseDir, 'offload', 'sess-1');
    expect(path.resolve(absPath)).toBe(path.resolve(sessionDir, 'spill', path.basename(absPath)));
    expect(fs.existsSync(path.join(sessionDir, 'spill'))).toBe(true);
  });

  it('does not create offload.jsonl and leaves the ref ledger untouched', () => {
    store.writeSpill('sess-2', 'mcp__docs__search', 'big output');

    const sessionDir = path.join(baseDir, 'offload', 'sess-2');
    expect(fs.existsSync(path.join(sessionDir, 'offload.jsonl'))).toBe(false);
    expect(store.getSessionRecords('sess-2')).toEqual([]);
    expect(store.countTokens(store.getSessionRecords('sess-2'))).toBe(0);
  });

  it('keeps the ref budget unaffected when spills coexist with real offload records', () => {
    store.writeToolResult('mixed', 1, 'shell', { cmd: 'ls' }, 'ok', false);
    store.writeSpill('mixed', 'mcp__fs__read', 'spilled');
    store.writeSpill('mixed', 'mcp__fs__read', 'spilled again');

    const records = store.getSessionRecords('mixed');
    expect(records).toHaveLength(1);
    expect(records[0].nodeId).toBe('node-001');
    expect(store.countTokens(records)).toBe(store.countTokens([records[0]]));
  });

  it('sanitizes the tool name into the filename', () => {
    const { absPath } = store.writeSpill('sess-3', 'mcp__../fs/read', 'data');

    expect(path.basename(absPath)).toMatch(/^\d+-mcp_fs_read\.md$/);
    expect(fs.existsSync(path.join(baseDir, 'offload', 'fs'))).toBe(false);
  });

  it('collision-safes two spills landing in the same millisecond', () => {
    const first = store.writeSpill('sess-4', 'mcp__fs__read', 'one');
    const second = store.writeSpill('sess-4', 'mcp__fs__read', 'two');

    expect(second.absPath).not.toBe(first.absPath);
    expect(second.refPath).not.toBe(first.refPath);
    expect(fs.readFileSync(first.absPath, 'utf-8')).toBe('one');
    expect(fs.readFileSync(second.absPath, 'utf-8')).toBe('two');
  });

  it('reclaims spills together with the session directory', () => {
    const { absPath } = store.writeSpill('sess-5', 'mcp__fs__read', 'data');
    expect(fs.existsSync(absPath)).toBe(true);

    store.deleteSession('sess-5');
    expect(fs.existsSync(absPath)).toBe(false);
  });
});

// ── mcp_servers prompt section ────────────────────────────────────────────────

function createDeps(overrides?: Partial<PromptManagerDeps>): PromptManagerDeps {
  return { uiLanguage: 'en', contextWindow: 200_000, ...overrides };
}

const SERVERS: McpPromptServer[] = [
  { name: 'filesystem', exposure: 'deferred', description: 'Local filesystem read/write' },
  { name: 'docs', exposure: 'direct', description: '' },
];

describe('PromptManager mcp_servers section', () => {
  let pm: PromptManager;

  beforeEach(() => {
    pm = new PromptManager(createDeps());
  });

  it('omits the section when mcpServers is absent', () => {
    const withoutMcp = pm.assemble({ agentId: 'default' });

    expect(withoutMcp.systemPrompt).not.toContain('mcp_servers');
    expect(withoutMcp.layers.map((l) => l.name)).not.toContain('mcp-servers');
  });

  it('omits the section when mcpServers is empty', () => {
    const empty = pm.assemble({ agentId: 'default', mcpServers: [] });

    expect(empty.systemPrompt).not.toContain('mcp_servers');
  });

  it('renders name, exposure and description per server, in order', () => {
    const withMcp = pm.assemble({ agentId: 'default', mcpServers: SERVERS });

    expect(withMcp.systemPrompt).toContain('## MCP servers');
    expect(withMcp.systemPrompt).toContain(
      '<mcp_servers>\n- filesystem (deferred): Local filesystem read/write\n- docs (direct)\n</mcp_servers>',
    );

    const layer = withMcp.layers.find((l) => l.name === 'mcp-servers');
    expect(layer).toBeDefined();
    expect(layer?.cacheKey).toBe('mcp-servers');
    expect(layer?.volatile).toBe(false);
  });

  it('keeps the rest of the prompt byte-identical when the section is added', () => {
    const withoutMcp = pm.assemble({ agentId: 'default' });
    const withMcp = pm.assemble({ agentId: 'default', mcpServers: [SERVERS[0]] });

    expect(withMcp.systemPrompt.startsWith(withoutMcp.systemPrompt)).toBe(true);
  });

  it('refreshes the assembled prompt when a server is edited or removed', () => {
    const initial = pm.assemble({ agentId: 'default', mcpServers: SERVERS });
    const renamed = pm.assemble({
      agentId: 'default',
      mcpServers: [{ name: 'renamed', exposure: 'deferred', description: 'Other' }],
    });
    const sameMillisecond = pm.assemble({ agentId: 'default', mcpServers: SERVERS });

    expect(renamed.systemPrompt).not.toContain('filesystem');
    expect(renamed.systemPrompt).toContain('renamed');
    // Same input still hits the memoized assembly.
    expect(sameMillisecond.systemPrompt).toBe(initial.systemPrompt);

    const changedExposure = pm.assemble({
      agentId: 'default',
      mcpServers: [
        { name: 'filesystem', exposure: 'direct', description: 'Local filesystem read/write' },
        { name: 'docs', exposure: 'direct', description: '' },
      ],
    });
    expect(changedExposure.systemPrompt).toContain('- filesystem (direct): Local filesystem');
  });

  it('escapes server names and descriptions inside the tag block', () => {
    const escaped = pm.assemble({
      agentId: 'default',
      mcpServers: [{ name: 'a&b', exposure: 'hidden', description: '<b>bold</b>' }],
    });

    expect(escaped.systemPrompt).toContain('- a&amp;b (hidden): &lt;b&gt;bold&lt;/b&gt;');
  });

  it('lists the section only for static servers, never connection state', () => {
    const withOnlyStaticFields = pm.assemble({
      agentId: 'default',
      mcpServers: [{ name: 'docs', exposure: 'deferred', description: 'Docs lookup' }],
    });

    expect(withOnlyStaticFields.systemPrompt).toContain('- docs (deferred): Docs lookup');
    expect(withOnlyStaticFields.systemPrompt).not.toContain('connect');
  });
});
