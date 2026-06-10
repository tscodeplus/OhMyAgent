import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MermaidPhaseTagger,
  PhaseTaggingResult,
} from '../../src/runtime-artifacts/mermaid-phase-tagger';
import { MermaidCanvas, MermaidNode } from '../../src/runtime-artifacts/mermaid-canvas';
import type { DistillerLLM } from '../../src/memory/persona-distiller';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockLLM(): DistillerLLM {
  return { call: vi.fn() };
}

function makeMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    child: vi.fn(() => makeMockLogger()),
    level: 'debug',
  } as any;
}

/**
 * Create a minimal MermaidNode for testing.
 */
function makeNode(
  id: string,
  toolName: string,
  overrides: Partial<MermaidNode> = {},
): MermaidNode {
  return {
    id,
    toolName,
    summary: overrides.summary ?? '',
    status: overrides.status ?? 'success',
    phase: overrides.phase ?? MermaidCanvas.inferPhase(toolName),
    priority: overrides.priority ?? 1,
    ...overrides,
  };
}

const VALID_LLM_RESPONSE = JSON.stringify({
  phases: ['环境准备', '配置分析', '部署验证'],
  mapping: {
    'node-001': '环境准备',
    'node-002': '环境准备',
    'node-003': '配置分析',
    'node-004': '部署验证',
    'node-005': '部署验证',
  },
});

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('MermaidPhaseTagger', () => {
  let llm: DistillerLLM;
  let logger: ReturnType<typeof makeMockLogger>;

  beforeEach(() => {
    llm = makeMockLLM();
    logger = makeMockLogger();
  });

  // -----------------------------------------------------------------------
  // tagPhases — too few nodes
  // -----------------------------------------------------------------------

  describe('tagPhases with < 3 nodes', () => {
    it('0 条节点 → 不调用 LLM → 返回 null', async () => {
      const tagger = new MermaidPhaseTagger(llm, logger);
      const result = await tagger.tagPhases([]);
      expect(result).toBeNull();
      expect(llm.call).not.toHaveBeenCalled();
    });

    it('1 条节点 → 不调用 LLM → 返回 null', async () => {
      const tagger = new MermaidPhaseTagger(llm, logger);
      const result = await tagger.tagPhases([makeNode('node-001', 'shell')]);
      expect(result).toBeNull();
      expect(llm.call).not.toHaveBeenCalled();
    });

    it('2 条节点 → 不调用 LLM → 返回 null', async () => {
      const tagger = new MermaidPhaseTagger(llm, logger);
      const result = await tagger.tagPhases([
        makeNode('node-001', 'shell'),
        makeNode('node-002', 'file_read'),
      ]);
      expect(result).toBeNull();
      expect(llm.call).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // tagPhases — boundary: exactly 3 nodes
  // -----------------------------------------------------------------------

  describe('tagPhases with exactly 3 nodes', () => {
    it('3 条节点（边界值）→ 正常调用 LLM → 返回正确结果', async () => {
      vi.mocked(llm.call).mockResolvedValueOnce(VALID_LLM_RESPONSE);

      const tagger = new MermaidPhaseTagger(llm, logger);
      const nodes = [
        makeNode('node-001', 'shell', { summary: 'apt update' }),
        makeNode('node-002', 'shell', { summary: 'install nodejs' }),
        makeNode('node-003', 'file_read', { summary: 'config.yaml' }),
      ];
      const result = await tagger.tagPhases(nodes);

      expect(result).not.toBeNull();
      expect(result!.phases).toEqual(['环境准备', '配置分析', '部署验证']);
      expect(result!.mapping['node-001']).toBe('环境准备');
      expect(result!.mapping['node-002']).toBe('环境准备');
      expect(result!.mapping['node-003']).toBe('配置分析');

      // Verify that prompt includes node info
      const userPrompt = vi.mocked(llm.call).mock.calls[0][1];
      expect(userPrompt).toContain('node-001');
      expect(userPrompt).toContain('shell');
      expect(userPrompt).toContain('apt update');
    });
  });

  // -----------------------------------------------------------------------
  // tagPhases — 5 nodes, happy path
  // -----------------------------------------------------------------------

  describe('tagPhases with 5 nodes', () => {
    it('5 条节点 → LLM 返回合法 JSON → 正确解析 PhaseTaggingResult', async () => {
      vi.mocked(llm.call).mockResolvedValueOnce(VALID_LLM_RESPONSE);

      const tagger = new MermaidPhaseTagger(llm, logger);
      const nodes = [
        makeNode('node-001', 'shell', { summary: 'apt update' }),
        makeNode('node-002', 'shell', { summary: 'install nodejs' }),
        makeNode('node-003', 'file_read', { summary: 'config.yaml' }),
        makeNode('node-004', 'file_write', { summary: 'modified config' }),
        makeNode('node-005', 'http_request', { summary: 'deploy API call' }),
      ];
      const result = await tagger.tagPhases(nodes);

      expect(result).not.toBeNull();
      expect(result!.phases).toHaveLength(3);
      expect(result!.phases).toEqual(['环境准备', '配置分析', '部署验证']);
      expect(result!.mapping['node-001']).toBe('环境准备');
      expect(result!.mapping['node-002']).toBe('环境准备');
      expect(result!.mapping['node-003']).toBe('配置分析');
      expect(result!.mapping['node-004']).toBe('部署验证');
      expect(result!.mapping['node-005']).toBe('部署验证');
    });

    it('LLM 返回带有 markdown 代码围栏的 JSON → 正确提取', async () => {
      const fencedResponse = [
        '```json',
        '{',
        '  "phases": ["准备", "执行"],',
        '  "mapping": {',
        '    "node-001": "准备",',
        '    "node-002": "执行"',
        '  }',
        '}',
        '```',
      ].join('\n');
      vi.mocked(llm.call).mockResolvedValueOnce(fencedResponse);

      const tagger = new MermaidPhaseTagger(llm, logger);
      const nodes = [
        makeNode('node-001', 'shell', { summary: 'setup' }),
        makeNode('node-002', 'shell', { summary: 'run' }),
        makeNode('node-003', 'shell', { summary: 'cleanup' }),
      ];
      const result = await tagger.tagPhases(nodes);

      expect(result).not.toBeNull();
      expect(result!.phases).toEqual(['准备', '执行']);
    });
  });

  // -----------------------------------------------------------------------
  // tagPhases — LLM error handling
  // -----------------------------------------------------------------------

  describe('tagPhases — LLM error handling', () => {
    it('LLM 返回非法 JSON → 返回 null', async () => {
      vi.mocked(llm.call).mockResolvedValueOnce('这不是 JSON');

      const tagger = new MermaidPhaseTagger(llm, logger);
      const nodes = [
        makeNode('node-001', 'shell'),
        makeNode('node-002', 'shell'),
        makeNode('node-003', 'shell'),
      ];
      const result = await tagger.tagPhases(nodes);

      expect(result).toBeNull();
    });

    it('LLM 返回不完整的 JSON（缺少 phases）→ 返回 null', async () => {
      vi.mocked(llm.call).mockResolvedValueOnce(
        JSON.stringify({ mapping: { 'node-001': '阶段一' } }),
      );

      const tagger = new MermaidPhaseTagger(llm, logger);
      const nodes = [
        makeNode('node-001', 'shell'),
        makeNode('node-002', 'shell'),
        makeNode('node-003', 'shell'),
      ];
      const result = await tagger.tagPhases(nodes);

      expect(result).toBeNull();
    });

    it('LLM 返回 phases 为空数组 → 返回 null', async () => {
      vi.mocked(llm.call).mockResolvedValueOnce(
        JSON.stringify({ phases: [], mapping: {} }),
      );

      const tagger = new MermaidPhaseTagger(llm, logger);
      const nodes = [
        makeNode('node-001', 'shell'),
        makeNode('node-002', 'shell'),
        makeNode('node-003', 'shell'),
      ];
      const result = await tagger.tagPhases(nodes);

      expect(result).toBeNull();
    });

    it('LLM 返回 phases 超过 5 个 → 返回 null', async () => {
      vi.mocked(llm.call).mockResolvedValueOnce(
        JSON.stringify({
          phases: ['一', '二', '三', '四', '五', '六'],
          mapping: { 'node-001': '一' },
        }),
      );

      const tagger = new MermaidPhaseTagger(llm, logger);
      const nodes = [
        makeNode('node-001', 'shell'),
        makeNode('node-002', 'shell'),
        makeNode('node-003', 'shell'),
      ];
      const result = await tagger.tagPhases(nodes);

      expect(result).toBeNull();
    });

    it('LLM 抛出异常 → 返回 null', async () => {
      vi.mocked(llm.call).mockRejectedValueOnce(new Error('Network error'));

      const tagger = new MermaidPhaseTagger(llm, logger);
      const nodes = [
        makeNode('node-001', 'shell'),
        makeNode('node-002', 'shell'),
        makeNode('node-003', 'shell'),
      ];
      const result = await tagger.tagPhases(nodes);

      expect(result).toBeNull();
    });

    it('mapping 包含非字符串值 → 返回 null', async () => {
      vi.mocked(llm.call).mockResolvedValueOnce(
        JSON.stringify({
          phases: ['阶段一'],
          mapping: { 'node-001': 123 },
        }),
      );

      const tagger = new MermaidPhaseTagger(llm, logger);
      const nodes = [
        makeNode('node-001', 'shell'),
        makeNode('node-002', 'shell'),
        makeNode('node-003', 'shell'),
      ];
      const result = await tagger.tagPhases(nodes);

      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // applyToCanvas
  // -----------------------------------------------------------------------

  describe('applyToCanvas', () => {
    it('正确更新 canvas 中节点的 phase', () => {
      const canvas = new MermaidCanvas();
      canvas.addNode({
        seq: 1,
        toolName: 'shell',
        toolArgs: {},
        refPath: '001-shell.md',
        timestamp: Date.now(),
        nodeId: 'node-001',
        summary: 'apt update',
        status: 'success',
      });
      canvas.addNode({
        seq: 2,
        toolName: 'shell',
        toolArgs: {},
        refPath: '002-shell.md',
        timestamp: Date.now(),
        nodeId: 'node-002',
        summary: 'install nodejs',
        status: 'success',
      });
      canvas.addNode({
        seq: 3,
        toolName: 'file_read',
        toolArgs: {},
        refPath: '003-file_read.md',
        timestamp: Date.now(),
        nodeId: 'node-003',
        summary: 'config.yaml',
        status: 'success',
      });

      const tagger = new MermaidPhaseTagger(llm, logger);
      const result: PhaseTaggingResult = {
        phases: ['环境准备', '配置分析'],
        mapping: {
          'node-001': '环境准备',
          'node-002': '环境准备',
          'node-003': '配置分析',
        },
      };

      tagger.applyToCanvas(canvas, result);

      expect(canvas.getNode('node-001')!.phase).toBe('环境准备');
      expect(canvas.getNode('node-002')!.phase).toBe('环境准备');
      expect(canvas.getNode('node-003')!.phase).toBe('配置分析');
    });

    it('不存在的 nodeId → 静默跳过', () => {
      const canvas = new MermaidCanvas();
      // Only add one node
      canvas.addNode({
        seq: 1,
        toolName: 'shell',
        toolArgs: {},
        refPath: '001-shell.md',
        timestamp: Date.now(),
        nodeId: 'node-001',
        summary: '',
        status: 'success',
      });

      const tagger = new MermaidPhaseTagger(llm, logger);
      const result: PhaseTaggingResult = {
        phases: ['环境准备'],
        mapping: {
          'node-001': '环境准备',
          'node-999': '环境准备', // does not exist — should be silently skipped
        },
      };

      // Should not throw
      expect(() => tagger.applyToCanvas(canvas, result)).not.toThrow();

      // Existing node should still be updated
      expect(canvas.getNode('node-001')!.phase).toBe('环境准备');
    });

    it('空 mapping → 不改变任何节点 phase', () => {
      const canvas = new MermaidCanvas();
      canvas.addNode({
        seq: 1,
        toolName: 'shell',
        toolArgs: {},
        refPath: '001-shell.md',
        timestamp: Date.now(),
        nodeId: 'node-001',
        summary: '',
        status: 'success',
      });

      const tagger = new MermaidPhaseTagger(llm, logger);
      const result: PhaseTaggingResult = {
        phases: ['执行'],
        mapping: {},
      };

      tagger.applyToCanvas(canvas, result);
      // Phase should remain the default (inferred by canvas)
      expect(canvas.getNode('node-001')!.phase).toBe('执行');
    });
  });

  // -----------------------------------------------------------------------
  // tagPhases — LLM returns mapping with extra/unknown node IDs
  // -----------------------------------------------------------------------

  describe('tagPhases — LLM returns extra node IDs in mapping', () => {
    it('LLM 返回的 mapping 包含不存在的 nodeId → 自动过滤', async () => {
      vi.mocked(llm.call).mockResolvedValueOnce(
        JSON.stringify({
          phases: ['阶段一'],
          mapping: {
            'node-001': '阶段一',
            'node-999': '阶段一', // not in our input
            'node-888': '阶段一', // not in our input
          },
        }),
      );

      const tagger = new MermaidPhaseTagger(llm, logger);
      const nodes = [
        makeNode('node-001', 'shell'),
        makeNode('node-002', 'shell'),
        makeNode('node-003', 'shell'),
      ];
      const result = await tagger.tagPhases(nodes);

      expect(result).not.toBeNull();
      // node-999 and node-888 should be filtered out
      expect(Object.keys(result!.mapping)).toEqual(['node-001']);
    });
  });
});
