import { OffloadRecord } from './offload-store.js';

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface MermaidNode {
  id: string;
  toolName: string;
  summary: string;
  status: 'running' | 'success' | 'error';
  phase: string;
  priority: number;
}

export interface MermaidEdge {
  from: string;
  to: string;
  label?: string;
}

// ---------------------------------------------------------------------------
// MermaidCanvas
// ---------------------------------------------------------------------------

export class MermaidCanvas {
  private nodes: Map<string, MermaidNode> = new Map();
  private edges: MermaidEdge[] = [];
  /** Insertion order tracking (node IDs). */
  private insertOrder: string[] = [];
  /** Sets of node IDs that belong to explicit parallel branches. */
  private parallelGroups: Set<string>[] = [];

  /**
   * Default phase mapping from tool name to Chinese phase label.
   */
  static readonly TOOL_PHASE_MAP: Record<string, string> = {
    shell: '执行',
    bash: '执行',
    exec: '执行',
    file_read: '分析',
    read_file: '分析',
    file_write: '修改',
    write_file: '修改',
    http_request: '网络',
    fetch: '网络',
    web_fetch: '网络',
    web_search: '网络',
    search: '网络',
    'memory-store': '记忆',
    'memory-recall': '记忆',
  };

  /**
   * Infer phase label from a tool name.
   */
  static inferPhase(toolName: string): string {
    return MermaidCanvas.TOOL_PHASE_MAP[toolName] ?? '其他';
  }

  // -----------------------------------------------------------------------
  // Node & edge management
  // -----------------------------------------------------------------------

  /**
   * Add a node from an `OffloadRecord`.
   *
   * Phase is automatically inferred from the tool name. An edge from the
   * previously added node (if any) is created automatically to represent
   * temporal ordering.
   */
  addNode(record: OffloadRecord): void {
    const phase = MermaidCanvas.inferPhase(record.toolName);
    const node: MermaidNode = {
      id: record.nodeId,
      toolName: record.toolName,
      summary: record.summary,
      status: record.status === 'error' ? 'error' : 'success',
      phase,
      priority: record.seq,
    };
    this.nodes.set(node.id, node);

    // Auto-edge from previous node in insertion order
    if (this.insertOrder.length > 0) {
      const prevId = this.insertOrder[this.insertOrder.length - 1];
      // prevId always exists in this.nodes at this point
      this.edges.push({ from: prevId, to: node.id });
    }
    this.insertOrder.push(node.id);
  }

  /**
   * Manually add a labelled edge between two nodes.
   */
  addEdge(from: string, to: string, label?: string): void {
    this.edges.push({ from, to, label });
  }

  /**
   * Mark a set of nodes as a parallel branch.
   *
   * Edges that connect consecutive node IDs within the branch receive a
   * "分支" label so that `toMermaid()` renders them as dashed arrows.
   */
  addParallelBranch(nodeIds: string[]): void {
    if (nodeIds.length < 2) return;
    this.parallelGroups.push(new Set(nodeIds));

    for (let i = 0; i < nodeIds.length - 1; i++) {
      const edge = this.edges.find(
        (e) => e.from === nodeIds[i] && e.to === nodeIds[i + 1],
      );
      if (edge) {
        edge.label = '分支';
      }
    }
  }

  // -----------------------------------------------------------------------
  // Query
  // -----------------------------------------------------------------------

  /** Return the node with the given ID, or `undefined`. */
  getNode(id: string): MermaidNode | undefined {
    return this.nodes.get(id);
  }

  /** Total number of nodes in the canvas. */
  get size(): number {
    return this.nodes.size;
  }

  /** Return the phase of the last inserted node. */
  getCurrentPhase(): string {
    if (this.insertOrder.length === 0) return '';
    const lastId = this.insertOrder[this.insertOrder.length - 1];
    return this.nodes.get(lastId)?.phase ?? '';
  }

  /** Export all nodes (e.g. for serialization). */
  getAllNodes(): MermaidNode[] {
    return Array.from(this.nodes.values());
  }

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------

  /**
   * Decide whether an edge should be rendered as dashed (`-.->`) instead of
   * solid (`-->`).
   *
   * Dashed edges indicate potential parallelism — either explicitly declared
   * via `addParallelBranch()` or inferred when two consecutive nodes belong
   * to different phases (different tool categories).
   */
  private isDashedEdge(edge: MermaidEdge): boolean {
    // Explicit parallel group overrides everything.
    if (
      this.parallelGroups.some((g) => g.has(edge.from) && g.has(edge.to))
    ) {
      return true;
    }
    // Different phases suggest these tasks could have run in parallel.
    const fromNode = this.nodes.get(edge.from);
    const toNode = this.nodes.get(edge.to);
    if (fromNode && toNode && fromNode.phase !== toNode.phase) {
      return true;
    }
    return false;
  }

  /**
   * Generate the complete Mermaid flowchart (LR) in a Markdown fenced block.
   *
   * Nodes are rendered with status icons (success/error/running), phase
   * label, and tool name. Edges are solid (`-->`) for sequential or dashed
   * (`-.->`) for parallel-capable flows. CSS classes are emitted as
   * `classDef` lines at the end.
   */
  toMermaid(): string {
    const lines: string[] = [];
    lines.push('```mermaid');
    lines.push('flowchart LR');

    // Node declarations
    for (const node of this.nodes.values()) {
      const icon =
        node.status === 'success'
          ? '✅'
          : node.status === 'error'
            ? '❌'
            : '⏳';
      let label = `${icon} ${node.phase} ${node.toolName}`;
      if (node.summary) {
        label += `: ${node.summary}`;
      }
      lines.push(`  ${node.id}["${escapeMermaidLabel(label)}"]:::${node.status}`);
    }

    // Edge declarations
    for (const edge of this.edges) {
      const dashed = this.isDashedEdge(edge);
      const arrow = dashed ? '-.->' : '-->';
      if (edge.label) {
        lines.push(`  ${edge.from} ${arrow}|"${edge.label}"| ${edge.to}`);
      } else {
        lines.push(`  ${edge.from} ${arrow} ${edge.to}`);
      }
    }

    // CSS class definitions
    lines.push('  classDef success fill:#90EE90');
    lines.push('  classDef error fill:#FFB6C1');
    lines.push('  classDef running fill:#87CEEB');

    lines.push('```');
    return lines.join('\n');
  }

  /**
   * Generate a concise Chinese text summary of task progress, suitable for
   * LLM context injection.
   *
   * Example output:
   * ```
   * [任务进度] 当前阶段: 网络 (3/4 完成)
   * 执行: [✅ node-001: shell ls]
   * 分析: [❌ node-002: file_read]
   * 网络: [✅ node-003: http_request] [⬜ node-004: web_search]
   * ```
   */
  toContextSummary(): string {
    if (this.nodes.size === 0) {
      return '';
    }

    // Group nodes by phase (preserving insertion order within each group).
    const phaseGroups = new Map<string, MermaidNode[]>();
    for (const nodeId of this.insertOrder) {
      const node = this.nodes.get(nodeId)!;
      const arr = phaseGroups.get(node.phase) ?? [];
      arr.push(node);
      phaseGroups.set(node.phase, arr);
    }

    const currentPhase = this.getCurrentPhase();
    const total = this.nodes.size;
    const completed = Array.from(this.nodes.values()).filter(
      (n) => n.status !== 'running',
    ).length;

    const lines: string[] = [];
    lines.push(`[任务进度] 当前阶段: ${currentPhase} (${completed}/${total} 完成)`);

    for (const [phase, nodes] of phaseGroups) {
      const parts = nodes.map((n) => {
        const icon =
          n.status === 'success'
            ? '✅'
            : n.status === 'error'
              ? '❌'
              : '⬜';
        const desc = n.summary ? `${n.toolName} ${n.summary}` : n.toolName;
        return `[${icon} ${n.id}: ${desc}]`;
      });
      lines.push(`${phase}: ${parts.join(' ')}`);
    }

    return lines.join('\n');
  }

  // -----------------------------------------------------------------------
  // Factory
  // -----------------------------------------------------------------------

  /**
   * Reconstruct a canvas from an array of `OffloadRecord`s (e.g. loaded
   * from `offload.jsonl`).
   */
  static fromRecords(records: OffloadRecord[]): MermaidCanvas {
    const canvas = new MermaidCanvas();
    for (const record of records) {
      canvas.addNode(record);
    }
    return canvas;
  }
}

function escapeMermaidLabel(label: string): string {
  const singleLine = label.replace(/\s+/g, ' ').trim();
  const truncated = singleLine.length > 220 ? singleLine.slice(0, 217) + '...' : singleLine;
  return truncated
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\]/g, '\\]');
}
