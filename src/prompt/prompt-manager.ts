import type {
  PromptLayer,
  PromptAssemblyOptions,
  PromptAssemblyResult,
  PromptManagerDeps,
  CacheAnchor,
} from './types.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const PRIORITY_BASE = 0;
const PRIORITY_SKILLS_CATALOG = 25;
const PRIORITY_AGENT_OVERRIDE = 50;
const PRIORITY_TEAM_MODE = 60;
const PRIORITY_CHILD_MODIFIER = 200;

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_SYSTEM_PROMPT_RATIO = 0.3;

// ── Token Estimation ──────────────────────────────────────────────────────────

/**
 * Simple token estimation based on character count.
 * Approximates: English ~0.25 tokens/char, CJK ~0.5 tokens/char.
 * Falls between tiktoken cl100k_base and a naive char/4 estimate.
 */
function estimateTokensForText(text: string): number {
  let tokens = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code <= 0x7f) {
      // ASCII → ~0.25 tokens/char
      tokens += 0.25;
    } else if (code >= 0x4e00 && code <= 0x9fff) {
      // CJK Unified → ~0.5 tokens/char
      tokens += 0.5;
    } else if (code >= 0x3000 && code <= 0x303f) {
      // CJK punctuation → ~0.5
      tokens += 0.5;
    } else {
      // Other Unicode → ~0.4 tokens/char
      tokens += 0.4;
    }
  }
  return Math.ceil(tokens);
}

// ── PromptManager ─────────────────────────────────────────────────────────────

export class PromptManager {
  private deps: PromptManagerDeps;
  private agentOverrideCache: Map<string, string> = new Map();

  constructor(deps: PromptManagerDeps) {
    this.deps = deps;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  assemble(options: PromptAssemblyOptions = {}): PromptAssemblyResult {
    const layers = this.collectLayers(options);
    const merged = this.mergeAndSort(layers, options);
    const tokenCount = estimateTokensForText(merged);

    const maxTokens =
      options.maxTokens ??
      Math.floor(
        (this.deps.contextWindow ?? DEFAULT_CONTEXT_WINDOW) *
          DEFAULT_MAX_SYSTEM_PROMPT_RATIO,
      );

    const budgetWarnings: string[] = [];
    let finalPrompt = merged;
    if (tokenCount > maxTokens) {
      budgetWarnings.push(
        `System prompt token count (${tokenCount}) exceeds budget (${maxTokens}). Trimming volatile layers.`,
      );
      finalPrompt = this.trimToBudget(layers, maxTokens, budgetWarnings);
    }

    return {
      systemPrompt: finalPrompt,
      layers,
      tokenCount: tokenCount > maxTokens ? estimateTokensForText(finalPrompt) : tokenCount,
      budgetWarnings,
      cacheBreakpoints: this.buildCacheBreakpoints(layers),
    };
  }

  estimateTokens(text: string): number {
    return estimateTokensForText(text);
  }

  getCacheStrategy(layers: PromptLayer[]): CacheAnchor[] {
    return this.buildCacheBreakpoints(layers);
  }

  invalidateAgentCache(agentId: string): void {
    // Remove all language variants for this agentId
    for (const key of this.agentOverrideCache.keys()) {
      if (key.startsWith(`agent:${agentId}:`)) {
        this.agentOverrideCache.delete(key);
      }
    }
  }

  // ── Layer Collection ────────────────────────────────────────────────────────

  private collectLayers(options: PromptAssemblyOptions): PromptLayer[] {
    const layers: PromptLayer[] = [];

    // Layer 1: Base prompt (from i18n)
    layers.push(this.buildBaseLayer(options));

    // Layer 1.5: Skills catalog (L1 metadata — always present when skills exist)
    if (options.availableSkills && options.availableSkills.length > 0) {
      layers.push(this.buildSkillsCatalogLayer(options.availableSkills));
    }

    // Layer 2: Agent override (from config)
    if (options.agentId) {
      const agentLayer = this.buildAgentLayer(options.agentId, options);
      if (agentLayer) layers.push(agentLayer);
    }

    // Layer 2.5: Team mode orchestrator role (v7)
    if (options.isTeamMode) {
      layers.push(this.buildTeamModeLayer(options.teamModeMaxChildren));
    }

    // Layer 3: Child agent modifier
    if (options.isChildAgent) {
      layers.push(this.buildChildModifierLayer(options));
    }

    return layers;
  }

  private buildBaseLayer(options: PromptAssemblyOptions): PromptLayer {
    const t = this.deps.t;
    return {
      name: 'base',
      content: [
        t('prompts:base.identity'),
        '',
        t('prompts:base.memory.title'),
        t('prompts:base.memory.body'),
        '',
        t('prompts:base.cron.title'),
        t('prompts:base.cron.body'),
      ].join('\n'),
      priority: PRIORITY_BASE,
      cacheKey: 'base',
      volatile: false,
      blockTag: 'base',
    };
  }

  private buildSkillsCatalogLayer(
    availableSkills: NonNullable<PromptAssemblyOptions['availableSkills']>,
  ): PromptLayer {
    const t = this.deps.t;
    const lines: string[] = [];

    lines.push(t('prompts:skills.title'));
    lines.push('');

    lines.push(t('prompts:skills.intro'));
    lines.push('');

    lines.push(t('prompts:skills.availableSkills'));
    for (const skill of availableSkills) {
      lines.push(`- ${skill.name} ($${skill.id}): ${skill.description}`);
    }

    lines.push('');
    lines.push(t('prompts:skills.howToUse'));

    return {
      name: 'skills-catalog',
      content: lines.join('\n'),
      priority: PRIORITY_SKILLS_CATALOG,
      cacheKey: 'skills-catalog',
      volatile: false,
      blockTag: 'skills-catalog',
    };
  }

  private buildAgentLayer(
    agentId: string,
    options: PromptAssemblyOptions,
  ): PromptLayer | null {
    const lang = options.uiLanguage ?? this.deps.uiLanguage;
    const cacheKey = `agent:${agentId}:${lang}`;

    const content = this.agentOverrideCache.get(cacheKey);
    if (!content) return null;

    return {
      name: `agent:${agentId}`,
      content,
      priority: PRIORITY_AGENT_OVERRIDE,
      cacheKey,
      volatile: false,
      blockTag: `agent:${agentId}`,
    };
  }

  /**
   * Register an agent's system_prompt override (called by agent-factory after
   * resolving the agent config and rendering templates).
   */
  registerAgentOverride(agentId: string, renderedPrompt: string): void {
    const cacheKey = `agent:${agentId}:${this.deps.uiLanguage}`;
    this.agentOverrideCache.set(cacheKey, renderedPrompt);
  }

  private buildTeamModeLayer(maxChildren?: number): PromptLayer {
    return {
      name: 'team-mode',
      content: this.deps.t('prompts:team.role', {
        maxChildren: String(maxChildren ?? 4),
      }),
      priority: PRIORITY_TEAM_MODE,
      cacheKey: 'team-mode',
      volatile: false,
    };
  }

  renderTemplate(template: string, vars: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, name) =>
      vars[name] ?? `{{${name}}}`,
    );
  }

  private buildChildModifierLayer(options: PromptAssemblyOptions): PromptLayer {
    const t = this.deps.t;
    const taskDesc = options.childTaskDescription ?? t('prompts:child.defaultTask');
    return {
      name: 'child-modifier',
      content: t('prompts:child.rolePrefix') + '\n' + taskDesc,
      priority: PRIORITY_CHILD_MODIFIER,
      cacheKey: 'child',
      volatile: true,
      blockTag: 'child',
    };
  }

  // ── Merge & Sort ────────────────────────────────────────────────────────────

  private mergeAndSort(
    layers: PromptLayer[],
    _options: PromptAssemblyOptions,
  ): string {
    const sorted = [...layers].sort((a, b) => a.priority - b.priority);

    // Deduplicate: same name → later overwrites earlier
    const seen = new Map<string, PromptLayer>();
    for (const layer of sorted) {
      seen.set(layer.name, layer);
    }
    const deduped = [...seen.values()].sort((a, b) => a.priority - b.priority);

    return deduped.map(l => l.content).join('\n\n');
  }

  // ── Budget Trimming ─────────────────────────────────────────────────────────

  private trimToBudget(
    layers: PromptLayer[],
    maxTokens: number,
    warnings: string[],
  ): string {
    const stable = layers.filter(l => !l.volatile);
    const volatile = layers.filter(l => l.volatile);

    const stableParts: string[] = stable
      .sort((a, b) => a.priority - b.priority)
      .map(l => l.content);
    const volatileParts: string[] = volatile
      .sort((a, b) => a.priority - b.priority)
      .map(l => l.content);

    // Start with stable layers only
    const included: string[] = [...stableParts];

    // Try to add volatile layers one by one
    for (const vp of volatileParts) {
      const candidate = [...included, vp].join('\n\n');
      if (estimateTokensForText(candidate) <= maxTokens) {
        included.push(vp);
      } else {
        warnings.push(
          `Trimmed volatile layer at index ${volatileParts.indexOf(vp)} to stay within token budget.`,
        );
        break;
      }
    }

    return included.join('\n\n');
  }

  // ── Cache Strategy ──────────────────────────────────────────────────────────

  private buildCacheBreakpoints(layers: PromptLayer[]): CacheAnchor[] {
    const anchors: CacheAnchor[] = [];
    let blockIndex = 0;

    const sorted = [...layers].sort((a, b) => a.priority - b.priority);
    for (const layer of sorted) {
      if (!layer.volatile) {
        anchors.push({
          type: 'system',
          blockIndex,
          label: layer.cacheKey,
        });
      }
      blockIndex++;
    }

    return anchors;
  }
}
