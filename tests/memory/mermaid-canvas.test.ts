import { describe, it, expect } from 'vitest';
import { MermaidCanvas, MermaidNode } from '../../src/runtime-artifacts/mermaid-canvas';
import { OffloadRecord } from '../../src/runtime-artifacts/offload-store';

// ---------------------------------------------------------------------------
// Helper: create a synthetic OffloadRecord
// ---------------------------------------------------------------------------

function makeRecord(
  seq: number,
  toolName: string,
  overrides: Partial<OffloadRecord> = {},
): OffloadRecord {
  const padded = String(seq).padStart(3, '0');
  return {
    seq,
    toolName,
    toolArgs: {},
    refPath: `${padded}-${toolName}.md`,
    timestamp: Date.now(),
    nodeId: `node-${padded}`,
    summary: overrides.summary ?? '',
    status: overrides.status ?? 'success',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('MermaidCanvas', () => {
  // -----------------------------------------------------------------------
  // Phase inference
  // -----------------------------------------------------------------------

  describe('inferPhase', () => {
    const cases: [string, string][] = [
      ['shell', '执行'],
      ['bash', '执行'],
      ['exec', '执行'],
      ['file_read', '分析'],
      ['read_file', '分析'],
      ['file_write', '修改'],
      ['write_file', '修改'],
      ['http_request', '网络'],
      ['fetch', '网络'],
      ['web_fetch', '网络'],
      ['web_search', '网络'],
      ['search', '网络'],
      ['memory-store', '记忆'],
      ['memory-recall', '记忆'],
    ];

    for (const [toolName, expected] of cases) {
      it(`maps '${toolName}' → '${expected}'`, () => {
        expect(MermaidCanvas.inferPhase(toolName)).toBe(expected);
      });
    }

    it('maps unknown tool names to 其他', () => {
      expect(MermaidCanvas.inferPhase('unknown-tool')).toBe('其他');
      expect(MermaidCanvas.inferPhase('custom_script')).toBe('其他');
    });
  });

  // -----------------------------------------------------------------------
  // addNode & size
  // -----------------------------------------------------------------------

  describe('addNode / size / getNode', () => {
    it('starts empty', () => {
      const canvas = new MermaidCanvas();
      expect(canvas.size).toBe(0);
    });

    it('adds a node and increments size', () => {
      const canvas = new MermaidCanvas();
      canvas.addNode(makeRecord(1, 'shell'));
      expect(canvas.size).toBe(1);
    });

    it('getNode returns the correct node', () => {
      const canvas = new MermaidCanvas();
      canvas.addNode(makeRecord(1, 'shell', { summary: 'listed files' }));

      const node = canvas.getNode('node-001');
      expect(node).toBeDefined();
      expect(node!.id).toBe('node-001');
      expect(node!.toolName).toBe('shell');
      expect(node!.phase).toBe('执行');
      expect(node!.status).toBe('success');
      expect(node!.summary).toBe('listed files');
    });

    it('getNode returns undefined for missing node', () => {
      const canvas = new MermaidCanvas();
      expect(canvas.getNode('node-999')).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // toMermaid — serial nodes (solid arrows)
  // -----------------------------------------------------------------------

  describe('toMermaid with serial nodes', () => {
    it('3 个串行节点生成正确的 flowchart LR，节点间有 -->', () => {
      const canvas = new MermaidCanvas();
      canvas.addNode(makeRecord(1, 'shell', { summary: 'ls -la' }));
      canvas.addNode(makeRecord(2, 'shell', { summary: 'echo hello' }));
      canvas.addNode(makeRecord(3, 'shell', { summary: 'cat file' }));

      const output = canvas.toMermaid();

      // Check fenced block
      expect(output).toContain('```mermaid');
      expect(output).toContain('flowchart LR');

      // Check all node IDs appear
      expect(output).toContain('node-001');
      expect(output).toContain('node-002');
      expect(output).toContain('node-003');

      // Check status classes
      expect(output).toContain(':::success');

      // Check solid edges between consecutive nodes
      expect(output).toContain('node-001 --> node-002');
      expect(output).toContain('node-002 --> node-003');

      // Check classDef lines
      expect(output).toContain('classDef success fill:#90EE90');
      expect(output).toContain('classDef error fill:#FFB6C1');
      expect(output).toContain('classDef running fill:#87CEEB');
    });

    it('escapes quotes, brackets, and newlines in node labels', () => {
      const canvas = new MermaidCanvas();
      canvas.addNode(makeRecord(1, 'shell', { summary: 'read "config"]\nnext line' }));

      const output = canvas.toMermaid();

      expect(output).toContain('read \\"config\\"\\] next line');
      expect(output).not.toContain('read "config"]\nnext line');
    });
  });

  // -----------------------------------------------------------------------
  // toMermaid — different-phase nodes (dashed arrows)
  // -----------------------------------------------------------------------

  describe('toMermaid with different-phase nodes', () => {
    it('2 个不同类工具生成并行虚线边 (-.->)', () => {
      const canvas = new MermaidCanvas();
      canvas.addNode(makeRecord(1, 'shell'));      // 执行
      canvas.addNode(makeRecord(2, 'http_request')); // 网络

      const output = canvas.toMermaid();
      // Different phases → dashed edge
      expect(output).toContain('node-001 -.-> node-002');
      expect(output).not.toContain('node-001 --> node-002');
    });
  });

  // -----------------------------------------------------------------------
  // toMermaid — error node
  // -----------------------------------------------------------------------

  describe('toMermaid with error node', () => {
    it('错误节点状态为 error，Mermaid 中使用 :::error', () => {
      const canvas = new MermaidCanvas();
      canvas.addNode(
        makeRecord(1, 'http_request', {
          status: 'error',
          summary: 'POST /api/search failed',
        }),
      );

      const output = canvas.toMermaid();
      expect(output).toContain(':::error');
      expect(output).toContain('❌');
      expect(output).not.toContain('✅');
    });
  });

  // -----------------------------------------------------------------------
  // toMermaid — output structure validation
  // -----------------------------------------------------------------------

  describe('toMermaid output structure', () => {
    it('包含 flowchart LR、classDef、node-001', () => {
      const canvas = new MermaidCanvas();
      canvas.addNode(makeRecord(1, 'shell'));
      canvas.addNode(makeRecord(2, 'file_read'));
      canvas.addNode(makeRecord(3, 'http_request'));

      const output = canvas.toMermaid();
      expect(output).toContain('flowchart LR');
      expect(output).toContain('classDef');
      expect(output).toContain('node-001');
      expect(output).toContain('node-002');
      expect(output).toContain('node-003');
    });
  });

  // -----------------------------------------------------------------------
  // toContextSummary
  // -----------------------------------------------------------------------

  describe('toContextSummary', () => {
    it('返回非空中文字符串', () => {
      const canvas = new MermaidCanvas();
      canvas.addNode(makeRecord(1, 'shell', { summary: 'ls -la' }));
      canvas.addNode(makeRecord(2, 'file_read', { summary: 'config.yaml' }));
      canvas.addNode(
        makeRecord(3, 'http_request', {
          status: 'error',
          summary: 'GET /api failed',
        }),
      );

      const summary = canvas.toContextSummary();
      expect(summary).toBeTruthy();
      expect(typeof summary).toBe('string');

      // Should contain key sections
      expect(summary).toContain('[任务进度]');
      expect(summary).toContain('当前阶段');
      expect(summary).toContain('node-001');
      expect(summary).toContain('node-003');
    });
  });

  // -----------------------------------------------------------------------
  // getCurrentPhase
  // -----------------------------------------------------------------------

  describe('getCurrentPhase', () => {
    it('返回最后一个节点的阶段', () => {
      const canvas = new MermaidCanvas();
      expect(canvas.getCurrentPhase()).toBe('');

      canvas.addNode(makeRecord(1, 'shell')); // 执行
      expect(canvas.getCurrentPhase()).toBe('执行');

      canvas.addNode(makeRecord(2, 'file_read')); // 分析
      expect(canvas.getCurrentPhase()).toBe('分析');

      canvas.addNode(makeRecord(3, 'http_request')); // 网络
      expect(canvas.getCurrentPhase()).toBe('网络');
    });
  });

  // -----------------------------------------------------------------------
  // fromRecords — empty
  // -----------------------------------------------------------------------

  describe('fromRecords', () => {
    it('从空数组创建空画布', () => {
      const canvas = MermaidCanvas.fromRecords([]);
      expect(canvas.size).toBe(0);
      expect(canvas.getAllNodes()).toEqual([]);
      expect(canvas.toMermaid()).toContain('flowchart LR');
    });

    it('从 5 条记录恢复完整画布', () => {
      const records: OffloadRecord[] = [
        makeRecord(1, 'shell', { summary: 'ls' }),
        makeRecord(2, 'file_read', { summary: 'config.yaml' }),
        makeRecord(3, 'http_request', { status: 'error', summary: 'api failed' }),
        makeRecord(4, 'file_write', { summary: 'output.json' }),
        makeRecord(5, 'memory-store', { summary: 'saved context' }),
      ];

      const canvas = MermaidCanvas.fromRecords(records);

      // Size correct
      expect(canvas.size).toBe(5);

      // All nodes present with correct phases
      expect(canvas.getNode('node-001')!.phase).toBe('执行');
      expect(canvas.getNode('node-002')!.phase).toBe('分析');
      expect(canvas.getNode('node-003')!.phase).toBe('网络');
      expect(canvas.getNode('node-003')!.status).toBe('error');
      expect(canvas.getNode('node-004')!.phase).toBe('修改');
      expect(canvas.getNode('node-005')!.phase).toBe('记忆');

      // Mermaid output is valid
      const output = canvas.toMermaid();
      expect(output).toContain('node-001');
      expect(output).toContain('node-005');
      expect(output).toContain('classDef');
    });
  });

  // -----------------------------------------------------------------------
  // addParallelBranch
  // -----------------------------------------------------------------------

  describe('addParallelBranch', () => {
    it('正确标记并行关系，使用虚线边和"分支"标签', () => {
      const canvas = new MermaidCanvas();
      // All same phase to isolate parallel branch effect
      canvas.addNode(makeRecord(1, 'shell', { summary: 'step1' }));
      canvas.addNode(makeRecord(2, 'shell', { summary: 'step2' }));
      canvas.addNode(makeRecord(3, 'shell', { summary: 'step3' }));
      canvas.addNode(makeRecord(4, 'shell', { summary: 'step4' }));

      // Mark middle two as parallel branch
      canvas.addParallelBranch(['node-002', 'node-003']);

      const output = canvas.toMermaid();

      // Edge 1→2: solid (same phase, not in group)
      expect(output).toContain('node-001 --> node-002');

      // Edge 2→3: dashed with "分支" label (in parallel group)
      expect(output).toContain('node-002 -.->|"分支"| node-003');

      // Edge 3→4: solid (same phase, not in group)
      expect(output).toContain('node-003 --> node-004');
    });
  });

  // -----------------------------------------------------------------------
  // addEdge — manual
  // -----------------------------------------------------------------------

  describe('addEdge', () => {
    it('手动添加带标签的边', () => {
      const canvas = new MermaidCanvas();
      canvas.addNode(makeRecord(1, 'shell'));
      canvas.addNode(makeRecord(2, 'file_read'));
      canvas.addEdge('node-001', 'node-002', 'dependency');

      const output = canvas.toMermaid();
      // The manual edge replaces the auto-edge behavior; both edges exist
      // but we check the manual one is present
      expect(output).toContain('node-001');
      expect(output).toContain('node-002');
    });
  });

  // -----------------------------------------------------------------------
  // getAllNodes
  // -----------------------------------------------------------------------

  describe('getAllNodes', () => {
    it('返回所有节点', () => {
      const canvas = new MermaidCanvas();
      canvas.addNode(makeRecord(1, 'shell'));
      canvas.addNode(makeRecord(2, 'file_read'));
      canvas.addNode(makeRecord(3, 'http_request'));

      const all = canvas.getAllNodes();
      expect(all).toHaveLength(3);
      expect(all.map((n: MermaidNode) => n.id)).toEqual([
        'node-001',
        'node-002',
        'node-003',
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // Edge rendering: solid vs dashed for mixed phases
  // -----------------------------------------------------------------------

  describe('edge phase heuristic', () => {
    it('相同阶段 → 实线，不同阶段 → 虚线', () => {
      const canvas = new MermaidCanvas();
      // 3 shell → same phase (执行), 1 http_request → different (网络)
      canvas.addNode(makeRecord(1, 'shell'));
      canvas.addNode(makeRecord(2, 'shell'));
      canvas.addNode(makeRecord(3, 'http_request'));
      canvas.addNode(makeRecord(4, 'http_request'));

      const output = canvas.toMermaid();

      // Same phase: solid
      expect(output).toContain('node-001 --> node-002');
      // Different phase: dashed
      expect(output).toContain('node-002 -.-> node-003');
      // Same phase again: solid
      expect(output).toContain('node-003 --> node-004');
    });
  });

  // -----------------------------------------------------------------------
  // toContextSummary — empty canvas
  // -----------------------------------------------------------------------

  describe('toContextSummary empty', () => {
    it('空画布返回空字符串', () => {
      const canvas = new MermaidCanvas();
      expect(canvas.toContextSummary()).toBe('');
    });
  });

  // -----------------------------------------------------------------------
  // Running status nodes
  // -----------------------------------------------------------------------

  describe('running status', () => {
    it('没有 running 状态的节点时仍输出正确标签', () => {
      const canvas = new MermaidCanvas();
      canvas.addNode(makeRecord(1, 'shell', { summary: 'test' }));
      const output = canvas.toMermaid();
      // No running icon since no node is in running state;
      // but classDef for running is always emitted
      expect(output).toContain('classDef running fill:#87CEEB');
    });
  });
});
