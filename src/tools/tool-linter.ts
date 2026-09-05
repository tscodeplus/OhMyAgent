// ---------------------------------------------------------------------------
// P6 — tool description / naming orthogonality linter
// ---------------------------------------------------------------------------
//
// Mirrors src/skills/skill-linter.ts, but for tool definitions. Two adjacent,
// ambiguously-described tools are a main source of tool-selection errors
// (see MyDocs/TOOL_SURFACE_MINIMALISM_ANALYSIS.md §一.1). This linter catches
// the mechanical part of that failure mode:
//
//   errors   — missing description (a tool without a description is worse
//              than no tool)
//   warnings — description longer than 2 sentences, overly long description,
//              description not starting with a verb, near-duplicate
//              descriptions between two tools (Jaccard similarity)

export interface LintableTool {
  name: string;
  description: string;
}

export interface ToolLintIssue {
  level: 'error' | 'warning';
  tool: string;
  /** Second tool for similarity findings */
  relatedTool?: string;
  rule: string;
  message: string;
}

export interface ToolLintReport {
  toolsChecked: number;
  errors: ToolLintIssue[];
  warnings: ToolLintIssue[];
  get ok(): boolean;
}

const MAX_SENTENCES = 2;
const MAX_DESCRIPTION_LENGTH = 300;
const SIMILARITY_THRESHOLD = 0.6;

/** Common leading verbs (EN prefix forms + ZH verbs) for the verb-start rule. */
const VERB_PREFIXES = [
  // EN — prefix match covers inflections (read → reads/reading)
  'get',
  'read',
  'write',
  'edit',
  'list',
  'create',
  'delete',
  'remove',
  'update',
  'search',
  'find',
  'send',
  'run',
  'execute',
  'fetch',
  'download',
  'upload',
  'add',
  'set',
  'generate',
  'manage',
  'toggle',
  'stop',
  'start',
  'enter',
  'exit',
  'call',
  'describe',
  'invoke',
  'request',
  'capture',
  'record',
  'store',
  'load',
  'save',
  'parse',
  'extract',
  'summarize',
  'summarise',
  'convert',
  'check',
  'validate',
  'open',
  'close',
  'query',
  'move',
  'copy',
  'compare',
  'monitor',
  'analyze',
  'analyse',
  'retrieve',
  'enable',
  'disable',
  'view',
  'pause',
  'modify',
  'insert',
  'replace',
  'wait',
  'ask',
  'return',
  'look',
  'inspect',
  // ZH
  '获取',
  '读取',
  '写入',
  '编辑',
  '列出',
  '创建',
  '删除',
  '移除',
  '更新',
  '搜索',
  '查找',
  '发送',
  '执行',
  '运行',
  '下载',
  '上传',
  '添加',
  '设置',
  '生成',
  '管理',
  '切换',
  '停止',
  '启动',
  '调用',
  '请求',
  '捕获',
  '记录',
  '存储',
  '加载',
  '保存',
  '解析',
  '提取',
  '摘要',
  '总结',
  '转换',
  '检查',
  '校验',
  '打开',
  '关闭',
  '查询',
  '移动',
  '复制',
  '比较',
  '监听',
  '计算',
  '请求',
  '审批',
  '拦截',
  '阻止',
  '检索',
];

export function splitSentences(description: string): string[] {
  return description
    .split(/(?:[.!?。！？]+\s*)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function startsWithVerb(description: string): boolean {
  const firstWord = description.trim().split(/\s+/)[0] ?? '';
  if (!firstWord) return false;
  const lowered = firstWord.toLowerCase().replace(/[^a-z\u4e00-\u9fff]/g, '');
  return VERB_PREFIXES.some((v) => lowered.startsWith(v));
}

/**
 * Tokenize for similarity: lowercase word tokens; CJK text is split into
 * single characters so zh descriptions get meaningful overlap.
 */
function tokenize(description: string): Set<string> {
  const tokens = new Set<string>();
  const matches = description.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]/g) ?? [];
  for (const m of matches) tokens.add(m);
  return tokens;
}

export function descriptionSimilarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

export function lintToolDescriptions(tools: LintableTool[]): ToolLintReport {
  const errors: ToolLintIssue[] = [];
  const warnings: ToolLintIssue[] = [];

  for (const tool of tools) {
    const desc = (tool.description ?? '').trim();
    if (!desc) {
      errors.push({
        level: 'error',
        tool: tool.name,
        rule: 'description-required',
        message: `Tool "${tool.name}" has an empty description`,
      });
      continue;
    }

    const sentences = splitSentences(desc);
    if (sentences.length > MAX_SENTENCES) {
      warnings.push({
        level: 'warning',
        tool: tool.name,
        rule: 'description-concise',
        message: `Tool "${tool.name}" description has ${sentences.length} sentences (max ${MAX_SENTENCES})`,
      });
    }

    if (desc.length > MAX_DESCRIPTION_LENGTH) {
      warnings.push({
        level: 'warning',
        tool: tool.name,
        rule: 'description-length',
        message: `Tool "${tool.name}" description is ${desc.length} chars (max ${MAX_DESCRIPTION_LENGTH})`,
      });
    }

    if (!startsWithVerb(desc)) {
      warnings.push({
        level: 'warning',
        tool: tool.name,
        rule: 'verb-start',
        message: `Tool "${tool.name}" description should start with a verb: "${desc.slice(0, 60)}"`,
      });
    }
  }

  // Pairwise near-duplicate descriptions
  for (let i = 0; i < tools.length; i++) {
    const a = tools[i]!;
    if (!(a.description ?? '').trim()) continue;
    for (let j = i + 1; j < tools.length; j++) {
      const b = tools[j]!;
      if (!(b.description ?? '').trim()) continue;
      const sim = descriptionSimilarity(a.description, b.description);
      if (sim >= SIMILARITY_THRESHOLD) {
        warnings.push({
          level: 'warning',
          tool: a.name,
          relatedTool: b.name,
          rule: 'description-similar',
          message: `Tools "${a.name}" and "${b.name}" have near-duplicate descriptions (similarity ${sim.toFixed(2)}) — consider merging, renaming, or differentiating`,
        });
      }
    }
  }

  return {
    toolsChecked: tools.length,
    errors,
    warnings,
    get ok() {
      return errors.length === 0;
    },
  };
}
