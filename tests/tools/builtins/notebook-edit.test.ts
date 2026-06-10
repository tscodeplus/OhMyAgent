// ---------------------------------------------------------------------------
// Tests for notebook_edit v4 ToolDefinition tool
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNotebookEditToolDefinition } from '../../../src/tools/builtins/files/notebook-edit-definition.js';
import type { ToolExecutionContext } from '../../../src/tools/platform/tool-context.js';
import type { AppConfig } from '../../../src/app/types.js';
import { extractToolText, expectToolResultContains } from '../../helpers/tool-result.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyNb(): Record<string, unknown> {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: [],
  };
}

function createMockConfig(): AppConfig {
  return {
    logging: { level: 'info' },
    uiLanguage: 'en',
    showToolCalls: true,
    feishu: { enabled: false, appId: '', appSecret: '', verificationToken: '', encryptKey: '', wsEnabled: false },
    piAi: { provider: 'openai', model: 'gpt-4o', reasoningModel: 'o3-mini', apiKey: 'sk-test' },
    embedding: { baseUrl: 'https://test.com', apiKey: 'sk-test', model: 'text-embedding-ada-002', dimension: 1536 },
    database: { path: ':memory:' },
    rateLimit: { webhookMaxRequests: 100, webhookWindowMs: 60000 },
    tools: {
      shellEnabled: false, defaultTimeoutMs: 30000, maxOutputLength: 5000,
      toolsProfile: 'standard', shellExecMode: 'safe', shellAllowlist: [],
      shellApprovalMode: 'balanced', shellApprovalWhitelist: [],
      shellApprovalTimeoutSec: 120, shellApprovalTimeoutAction: 'deny',
      fileRead: { allowedRoots: [], deniedPatterns: [] },
    },
    memory: {
      autoRecall: false, autoCapture: false, recallTopK: 3, recallMinScore: 0.01,
      captureMaxChars: 500, summarizeInterval: 20, outputLanguage: 'Auto',
      decayHalfLifeDays: 0, embeddingCacheMaxEntries: 100,
      hygiene: { enabled: false, retentionDays: 90 },
      embeddingCircuitBreaker: { failureThreshold: 5, cooldownSec: 30 },
    },
    cron: { enabled: false, tickIntervalMs: 30000, dataDir: './cron', executionTimeoutMs: 600000 },
    webSearch: { providerOrder: ['tavily'], searchTimeoutMs: 10000, maxResults: 3 },
    extensions: { directory: 'extensions' },
    fallbackModels: [],
    footer: { showAgentName: true, showModel: true, showCompleted: true, showElapsed: true },
  };
}

function createMockCtx(config: AppConfig, cwd?: string): ToolExecutionContext {
  return {
    cwd: cwd ?? process.cwd(),
    services: { config } as any,
    policyScope: null as any,
  };
}

const toolDef = createNotebookEditToolDefinition();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('notebook_edit', () => {
  let tmpDir: string;
  let nbPath: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nb-test-'));
    nbPath = join(tmpDir, 'test.ipynb');
    writeFileSync(nbPath, JSON.stringify(emptyNb(), null, 2), 'utf-8');
  });

  afterAll(() => {
    try { unlinkSync(nbPath); } catch {}
    try { rmdirSync(tmpDir); } catch {}
  });

  // -----------------------------------------------------------------------
  // insert_cell
  // -----------------------------------------------------------------------

  it('inserts a code cell at the end when no index is given', async () => {
    const testNb = join(tmpDir, 'insert-end.ipynb');
    writeFileSync(testNb, JSON.stringify(emptyNb(), null, 2), 'utf-8');
    const ctx = createMockCtx(createMockConfig(), tmpDir);

    const result = await toolDef.execute(
      { filePath: 'insert-end.ipynb', action: 'insert_cell', cellType: 'code', source: 'print("hello")' },
      ctx,
    );
    expect(result.isError).toBeFalsy();

    const nb = JSON.parse(readFileSync(testNb, 'utf-8'));
    expect(nb.cells).toHaveLength(1);
    expect(nb.cells[0].cell_type).toBe('code');
    expect(nb.cells[0].source).toEqual(['print("hello")']);
    expect(nb.cells[0].outputs).toEqual([]);
    expect(nb.cells[0].execution_count).toBeNull();
    expect(nb.nbformat).toBe(4);
    expect(nb.metadata.kernelspec.name).toBe('python3');
    try { unlinkSync(testNb); } catch {}
  });

  it('inserts a cell at a specific index', async () => {
    const nb = emptyNb();
    nb.cells = [
      { cell_type: 'markdown', source: ['# First'], metadata: {} },
      { cell_type: 'markdown', source: ['# Third'], metadata: {} },
    ];
    const testNb = join(tmpDir, 'insert-index.ipynb');
    writeFileSync(testNb, JSON.stringify(nb, null, 2), 'utf-8');
    const ctx = createMockCtx(createMockConfig(), tmpDir);

    const result = await toolDef.execute(
      { filePath: 'insert-index.ipynb', action: 'insert_cell', cellType: 'code', source: 'x = 1', index: 1 },
      ctx,
    );
    expect(result.isError).toBeFalsy();

    const updated = JSON.parse(readFileSync(testNb, 'utf-8'));
    expect(updated.cells).toHaveLength(3);
    expect(updated.cells[0].cell_type).toBe('markdown');
    expect(updated.cells[1].cell_type).toBe('code');
    expect(updated.cells[2].cell_type).toBe('markdown');
    try { unlinkSync(testNb); } catch {}
  });

  it('rejects insert_cell without cellType', async () => {
    const ctx = createMockCtx(createMockConfig(), tmpDir);
    const result = await toolDef.execute(
      { filePath: 'test.ipynb', action: 'insert_cell', source: 'x = 1' } as any,
      ctx,
    );
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'cellType is required');
  });

  it('rejects insert_cell without source', async () => {
    const ctx = createMockCtx(createMockConfig(), tmpDir);
    const result = await toolDef.execute(
      { filePath: 'test.ipynb', action: 'insert_cell', cellType: 'code' } as any,
      ctx,
    );
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'source is required');
  });

  // -----------------------------------------------------------------------
  // replace_cell
  // -----------------------------------------------------------------------

  it('replaces a cell at a given index', async () => {
    const nb = emptyNb();
    nb.cells = [
      { cell_type: 'markdown', source: ['# Old'], metadata: {} },
    ];
    const testNb = join(tmpDir, 'replace.ipynb');
    writeFileSync(testNb, JSON.stringify(nb, null, 2), 'utf-8');
    const ctx = createMockCtx(createMockConfig(), tmpDir);

    const result = await toolDef.execute(
      { filePath: 'replace.ipynb', action: 'replace_cell', index: 0, cellType: 'code', source: 'y = 2' },
      ctx,
    );
    expect(result.isError).toBeFalsy();

    const updated = JSON.parse(readFileSync(testNb, 'utf-8'));
    expect(updated.cells).toHaveLength(1);
    expect(updated.cells[0].cell_type).toBe('code');
    expect(updated.cells[0].source).toEqual(['y = 2']);
    try { unlinkSync(testNb); } catch {}
  });

  it('rejects replace_cell with out-of-range index', async () => {
    const ctx = createMockCtx(createMockConfig(), tmpDir);
    const result = await toolDef.execute(
      { filePath: 'test.ipynb', action: 'replace_cell', index: 99, cellType: 'code', source: 'x' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'out of range');
  });

  // -----------------------------------------------------------------------
  // delete_cell
  // -----------------------------------------------------------------------

  it('deletes a cell at a given index', async () => {
    const nb = emptyNb();
    nb.cells = [
      { cell_type: 'markdown', source: ['# A'], metadata: {} },
      { cell_type: 'markdown', source: ['# B'], metadata: {} },
    ];
    const testNb = join(tmpDir, 'delete.ipynb');
    writeFileSync(testNb, JSON.stringify(nb, null, 2), 'utf-8');
    const ctx = createMockCtx(createMockConfig(), tmpDir);

    const result = await toolDef.execute(
      { filePath: 'delete.ipynb', action: 'delete_cell', index: 0 },
      ctx,
    );
    expect(result.isError).toBeFalsy();

    const updated = JSON.parse(readFileSync(testNb, 'utf-8'));
    expect(updated.cells).toHaveLength(1);
    expect(updated.cells[0].source).toEqual(['# B']);
    try { unlinkSync(testNb); } catch {}
  });

  it('rejects delete_cell with out-of-range index', async () => {
    const ctx = createMockCtx(createMockConfig(), tmpDir);
    const result = await toolDef.execute(
      { filePath: 'test.ipynb', action: 'delete_cell', index: 99 },
      ctx,
    );
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'out of range');
  });

  // -----------------------------------------------------------------------
  // update_cell_source
  // -----------------------------------------------------------------------

  it('updates cell source preserving outputs and metadata', async () => {
    const nb = emptyNb();
    nb.cells = [
      {
        cell_type: 'code',
        source: ['old code'],
        metadata: { tags: ['keep'] },
        outputs: [{ output_type: 'stream', text: ['hello'] }],
        execution_count: 5,
      },
    ];
    const testNb = join(tmpDir, 'update-source.ipynb');
    writeFileSync(testNb, JSON.stringify(nb, null, 2), 'utf-8');
    const ctx = createMockCtx(createMockConfig(), tmpDir);

    const result = await toolDef.execute(
      { filePath: 'update-source.ipynb', action: 'update_cell_source', index: 0, source: 'new code' },
      ctx,
    );
    expect(result.isError).toBeFalsy();

    const updated = JSON.parse(readFileSync(testNb, 'utf-8'));
    expect(updated.cells).toHaveLength(1);
    expect(updated.cells[0].source).toEqual(['new code']);
    // Preserved
    expect(updated.cells[0].metadata.tags).toEqual(['keep']);
    expect(updated.cells[0].outputs).toHaveLength(1);
    expect(updated.cells[0].execution_count).toBe(5);
    try { unlinkSync(testNb); } catch {}
  });

  // -----------------------------------------------------------------------
  // Error cases
  // -----------------------------------------------------------------------

  it('rejects a non-existent file', async () => {
    const ctx = createMockCtx(createMockConfig(), tmpDir);
    const result = await toolDef.execute(
      { filePath: 'nonexistent.ipynb', action: 'insert_cell', cellType: 'code', source: 'x' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'File not found');
  });

  it('rejects a non-ipynb JSON file (missing cells array)', async () => {
    const testNb = join(tmpDir, 'not-nb.json');
    writeFileSync(testNb, JSON.stringify({ name: 'test' }), 'utf-8');
    const ctx = createMockCtx(createMockConfig(), tmpDir);

    const result = await toolDef.execute(
      { filePath: 'not-nb.json', action: 'insert_cell', cellType: 'code', source: 'x' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'not a valid .ipynb notebook');

    try { unlinkSync(testNb); } catch {}
  });

  it('rejects invalid JSON file', async () => {
    const testNb = join(tmpDir, 'invalid.json');
    writeFileSync(testNb, '{invalid json}', 'utf-8');
    const ctx = createMockCtx(createMockConfig(), tmpDir);

    const result = await toolDef.execute(
      { filePath: 'invalid.json', action: 'insert_cell', cellType: 'code', source: 'x' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'not valid JSON');

    try { unlinkSync(testNb); } catch {}
  });
});
