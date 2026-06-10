import type {
  PromptAssemblyResult,
  PromptLayer,
  ChildAgentOptimizeOptions,
} from './types.js';

// ── Layer name patterns to strip for child agents ─────────────────────────────

const STRIP_LAYER_PATTERNS = [
  /^base$/i,                // Base layer (contains memory/cron instructions)
  /^agent:/,                // Agent override layer
  /^skill:/,                // Skill patches (child doesn't need parent's skill context)
];

// ── Content patterns to strip from base layer ─────────────────────────────────

const STRIP_CONTENT_SECTIONS = [
  /## Memory[\s\S]*?(?=## |$)/,        // Memory instructions block
  /## Scheduled Tasks[\s\S]*?(?=## |$)/, // Cronjob instructions block
  /## 记忆系统[\s\S]*?(?=## |$)/,        // Chinese Memory block
  /## 定时任务[\s\S]*?(?=## |$)/,        // Chinese Cron block
];

// ── Token estimation (standalone, no PromptManager needed) ────────────────────

function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code <= 0x7f) {
      tokens += 0.25;
    } else if (code >= 0x4e00 && code <= 0x9fff) {
      tokens += 0.5;
    } else if (code >= 0x3000 && code <= 0x303f) {
      tokens += 0.5;
    } else {
      tokens += 0.4;
    }
  }
  return Math.ceil(tokens);
}

// ── ChildAgentPromptOptimizer ─────────────────────────────────────────────────

export interface ChildAgentPromptOptimizerDeps {
  /** i18n translate function */
  t: (key: string, interpolations?: Record<string, string | number>) => string;
}

export class ChildAgentPromptOptimizer {
  private stripPatterns: RegExp[];
  private keepBlocks: Set<string>;
  private t: ChildAgentPromptOptimizerDeps['t'];

  constructor(
    deps: ChildAgentPromptOptimizerDeps,
    stripPatterns?: RegExp[],
    keepBlocks?: string[],
  ) {
    this.t = deps.t;
    this.stripPatterns = stripPatterns ?? [...STRIP_LAYER_PATTERNS];
    this.keepBlocks = new Set(keepBlocks ?? []);
  }

  optimize(options: ChildAgentOptimizeOptions): PromptAssemblyResult {
    const { parentAssembly, taskDescription } = options;
    const keepBlocks = new Set([
      ...this.keepBlocks,
      ...(options.keepBlocks ?? []),
    ]);

    const childLayers: PromptLayer[] = [];

    for (const layer of parentAssembly.layers) {
      if (keepBlocks.has(layer.name) || keepBlocks.has(layer.blockTag ?? '')) {
        childLayers.push(layer);
        continue;
      }

      const shouldStrip = this.stripPatterns.some(pattern =>
        pattern.test(layer.name),
      );

      if (shouldStrip) {
        // For base layer: keep layer but strip memory/cron content sections
        if (layer.name === 'base') {
          const stripped = this.stripContentSections(layer.content);
          if (stripped.trim()) {
            childLayers.push({ ...layer, content: stripped });
          }
        }
        // agent: / skill: layers are dropped entirely
      } else {
        childLayers.push(layer);
      }
    }

    // Build the task-scoped role layer
    const roleLayer: PromptLayer = {
      name: 'child-role',
      content: this.buildChildRoleContent(taskDescription),
      priority: 0,
      cacheKey: 'child',
      volatile: true,
      blockTag: 'child-role',
    };
    childLayers.unshift(roleLayer);

    // Assemble
    const sorted = childLayers.sort((a, b) => a.priority - b.priority);
    const merged = sorted.map(l => l.content).join('\n\n');

    return {
      systemPrompt: merged,
      layers: childLayers,
      tokenCount: estimateTokens(merged),
      budgetWarnings: [],
      cacheBreakpoints: [],
    };
  }

  private stripContentSections(content: string): string {
    let result = content;
    for (const pattern of STRIP_CONTENT_SECTIONS) {
      result = result.replace(pattern, '');
    }
    return result.replace(/\n{3,}/g, '\n\n').trim();
  }

  private buildChildRoleContent(taskDescription: string): string {
    const t = this.t;
    return [
      t('prompts:child.rolePrefix'),
      '',
      `## Task\n${taskDescription}`,
    ].join('\n');
  }
}
