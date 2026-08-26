import type {
  PromptLayer,
  PromptAssemblyOptions,
  PromptAssemblyResult,
  PromptManagerDeps,
  CacheAnchor,
} from './types.js';
import { LRUCache } from 'lru-cache';

// ── Constants ─────────────────────────────────────────────────────────────────

const PRIORITY_BASE = 0;
const PRIORITY_SKILLS_CATALOG = 25;
const PRIORITY_TOOLS_CATALOG = 26;
const PRIORITY_AGENT_OVERRIDE = 50;
const PRIORITY_TEAM_MODE = 60;
const PRIORITY_CHILD_MODIFIER = 200;

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_SYSTEM_PROMPT_RATIO = 0.3;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Escape text for XML embedding in prompt layers (skill catalog etc.). */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

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
  /**
   * Memoized assemble() results. The assembled system prompt is byte-stable
   * for a given (agent, language, skills fingerprint, tools fingerprint,
   * team-mode) tuple, but the layer merge + char-by-char token estimation
   * runs on every turn. Bounded LRU; bypassed when per-turn skill layers
   * are present. Invalidated when an agent override changes.
   */
  private assembleCache: LRUCache<string, PromptAssemblyResult> = new LRUCache({
    max: 50,
  });

  constructor(deps: PromptManagerDeps) {
    this.deps = deps;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  assemble(options: PromptAssemblyOptions = {}): PromptAssemblyResult {
    const cacheKey = this.assembleCacheKey(options);
    if (cacheKey) {
      const hit = this.assembleCache.get(cacheKey);
      if (hit) return hit;
    }
    const result = this.assembleUncached(options);
    if (cacheKey) this.assembleCache.set(cacheKey, result);
    return result;
  }

  /**
   * Cache key for assemble(). Returns null when the result must not be
   * cached (per-turn active skill layers make the output dynamic).
   * The registered agent override is folded into the key so a changed agent
   * prompt naturally produces a new key without explicit invalidation.
   */
  private assembleCacheKey(o: PromptAssemblyOptions): string | null {
    if (o.activeSkillLayers && o.activeSkillLayers.length > 0) return null;
    const lang = o.uiLanguage ?? this.deps.uiLanguage;
    const agentId = o.agentId ?? '';
    const override = agentId ? (this.agentOverrideCache.get(`agent:${agentId}:${lang}`) ?? '') : '';
    return [
      o.isChildAgent ? 'child' : 'main',
      agentId,
      override,
      lang,
      o.responseLanguage ?? '',
      o.channel ?? '',
      o.isTeamMode ? `team:${o.teamModeMaxChildren ?? ''}` : '',
      o.childTaskDescription ?? '',
      o.availableSkills?.map((s) => s.id).join(',') ?? '',
      o.availableTools?.map((t) => `${t.name}=${t.snippet}`).join('|') ?? '',
      o.includeCatalogs === false ? 'no-catalogs' : 'catalogs',
    ].join('\u0000');
  }

  private assembleUncached(options: PromptAssemblyOptions): PromptAssemblyResult {
    const layers = this.collectLayers(options);
    const merged = this.mergeAndSort(layers, options);
    const tokenCount = estimateTokensForText(merged);

    const maxTokens =
      options.maxTokens ??
      Math.floor(
        (this.deps.contextWindow ?? DEFAULT_CONTEXT_WINDOW) * DEFAULT_MAX_SYSTEM_PROMPT_RATIO,
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
    // Assembled prompts embed the override content in their cache key;
    // clear stale entries so memory doesn't hold dead prompts.
    this.assembleCache.clear();
  }

  // ── Layer Collection ────────────────────────────────────────────────────────

  private collectLayers(options: PromptAssemblyOptions): PromptLayer[] {
    const layers: PromptLayer[] = [];

    // Layer 1: Base prompt
    layers.push(this.buildBaseLayer(options));

    // Layer 1.5: Skills catalog (L1 metadata — always present when skills exist)
    // Both catalogs can be disabled via config for providers WITHOUT prompt
    // caching, where they are pure per-turn token overhead.
    if (options.includeCatalogs !== false) {
      if (options.availableSkills && options.availableSkills.length > 0) {
        layers.push(this.buildSkillsCatalogLayer(options.availableSkills));
      }

      // Layer 1.55: Tools catalog (one-line snippets — quick index for the model)
      if (options.availableTools && options.availableTools.length > 0) {
        layers.push(this.buildToolsCatalogLayer(options.availableTools));
      }
    }

    // Layer 1.6: Active skill prompt layers (injected from skill-compiler output)
    if (options.activeSkillLayers && options.activeSkillLayers.length > 0) {
      for (const layer of options.activeSkillLayers) {
        layers.push(layer);
      }
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
    const parts = [
      'You are OhMyAgent, a helpful AI assistant.',
      '',
      '## Task Execution',
      `You are an action-oriented agent that FINISHES tasks — not just replies.

- Multi-step task: plan silently first (what to do, in what order, what success looks like), then execute step by step.
- After each step, VERIFY the result before moving on. Never claim a step succeeded without confirming it.
- Never give up after one failure: read the error, fix the likely cause, retry once. After 3 identical failures with the same error, switch approach or ask the user.
- Keep working until the goal is reached, then report. Do not stop at the first intermediate result.
- Do not repeat an identical failed tool call (same tool, same arguments) unless the error was transient (network/rate-limit).
- Failures are feedback, not blockers: syntax/param errors → correct and retry; environment/access errors → try a fallback approach or tell the user exactly what is missing.
- Large tool output: keep only a summary in the conversation — never paste raw logs or full file contents. When a tool returns "Full result archived at ...", use file_read on that path if you need the complete output.
- If blocked, state the blocker and the next best step for the user — never pretend success. The task is complete only when the user's goal is achieved, or you have confirmed with the user that it cannot be.`,
      '',
      '## Memory',
      `Memory tools: **memory-store** (save preferences/facts/decisions), **memory-recall** (search past context), **summarize-session** (persist a concluded discussion into long-term memory).

1. When the user shares their name or how to address them, your name/identity, or personal preferences/habits/devices/skills → **immediately call memory-store** (do NOT just verbally acknowledge).
2. Use memory-recall when you need context about the user or past discussions.
3. After complex tasks or multi-turn discussions reach a natural conclusion, call summarize-session.

Example: User says "My name is Bob, call me Boss. Your name is Helper." → call memory-store twice (name/preference), not "OK".`,
      '',
      '## Scheduled Tasks (cronjob)',
      `Create scheduled/reminder tasks with the **cronjob** tool. Create the job immediately — do NOT ask clarifying questions about how/when/frequency.

- **prompt IS the final message the user receives**, written in natural language — reminder content directly; for information-gathering, write what to fetch and summarize.
- "remind me in X minutes about YYY" → action=create, name="Remind YYY", schedule="Xm", prompt="YYY".
- Schedule formats: "5m" / "30m" / "2d" = once after a delay; "every 2h" / "every 1d" = repeat; "0 9 * * *" = cron expression.
- Results are automatically delivered to this chat — no chat_id needed.`,
    ];

    // Append language instruction when responseLanguage is set
    if (options.responseLanguage) {
      parts.push('');
      parts.push(
        `IMPORTANT: You MUST respond in ${options.responseLanguage}. All memory entries, summaries, and user-facing output must also be in ${options.responseLanguage}.`,
      );
    }

    return {
      name: 'base',
      content: parts.join('\n'),
      priority: PRIORITY_BASE,
      cacheKey: 'base',
      volatile: false,
      blockTag: 'base',
    };
  }

  private buildSkillsCatalogLayer(
    availableSkills: NonNullable<PromptAssemblyOptions['availableSkills']>,
  ): PromptLayer {
    const lines: string[] = [];

    lines.push('## Skills');
    lines.push('');

    lines.push(
      'Skills are specialized instruction sets. Use the list below only to decide whether a skill fits the current task.',
    );
    lines.push('');

    lines.push('<available_skills>');
    for (const skill of availableSkills) {
      lines.push('  <skill>');
      lines.push(`    <name>${escapeXml(skill.name)}</name>`);
      lines.push(`    <id>${escapeXml(skill.id)}</id>`);
      lines.push(`    <trigger>$${escapeXml(skill.id)}</trigger>`);
      lines.push(`    <description>${escapeXml(skill.description)}</description>`);
      lines.push('  </skill>');
    }
    lines.push('</available_skills>');

    lines.push('');
    lines.push(`### How to use skills

If the user names \`$<skill-id>\` or \`/<skill-id>\` or the task clearly matches a listed description, use that skill for this turn. When a skill is activated, follow the loaded skill instructions; choose the smallest useful set and say which skill you are using. If no skill fits, continue normally.

When a skill fits the task, the full skill instructions are injected automatically; you may also read the complete SKILL.md via file_read on its path if the injected instructions are insufficient.

**Creating new skills** — when the user asks to create a new skill/capability/automation, use the \`skill_create\` tool (do NOT manually write a SKILL.md). The tool generates from a template, validates with lint, and reloads the registry.`);

    return {
      name: 'skills-catalog',
      content: lines.join('\n'),
      priority: PRIORITY_SKILLS_CATALOG,
      cacheKey: 'skills-catalog',
      volatile: false,
      blockTag: 'skills-catalog',
    };
  }

  private buildToolsCatalogLayer(
    availableTools: NonNullable<PromptAssemblyOptions['availableTools']>,
  ): PromptLayer {
    const lines: string[] = [];

    lines.push('## Available tools');
    lines.push('');
    lines.push(
      'The tools below are available in this session. Full parameter schemas are provided through the API; this list is only a quick index of what exists.',
    );
    lines.push('');
    lines.push('<available_tools>');
    for (const tool of availableTools) {
      lines.push('  <tool>');
      lines.push(`    <name>${escapeXml(tool.name)}</name>`);
      lines.push(`    <snippet>${escapeXml(tool.snippet)}</snippet>`);
      lines.push('  </tool>');
    }
    lines.push('</available_tools>');

    return {
      name: 'tools-catalog',
      content: lines.join('\n'),
      priority: PRIORITY_TOOLS_CATALOG,
      cacheKey: 'tools-catalog',
      volatile: false,
      blockTag: 'tools-catalog',
    };
  }

  private buildAgentLayer(agentId: string, options: PromptAssemblyOptions): PromptLayer | null {
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
    const max = maxChildren ?? 4;
    return {
      name: 'team-mode',
      content: `## Agent Team Mode

You are operating in Agent Team mode as the Orchestrator. You have the authority to use spawn_agent to create child agents for parallel task execution.

### Judgment Signals

**Spawn child agents when ANY 2 of these signals are present:**
- Task requires ≥ 5 steps or ≥ 3 different tools
- There are ≥ 2 independent sub-goals (no dependencies between them)
- Need to read and analyze ≥ 10 files (sequential reads would overflow context)
- Need a "fresh perspective" — investigate a problem without existing conversation bias
- User explicitly asks for comparative analysis, multi-dimensional evaluation, or "thorough check"

**Do NOT spawn when ANY 1 of these signals is present:**
- Can complete in 1-3 steps (look up a file, explain code, find a command)
- Message is a greeting, chitchat, or simple factual query
- Subtasks have strong dependencies (must wait for A before starting B)
- You are already coordinating multiple child agents in the Team context — wait for results first

### Plan-Before-Spawn (Required)

**Before calling spawn_agent, you MUST output a decomposition plan in your reply.** Format:

<plan>
### Subtask Decomposition
1. [Subtask name] → assigned to \`persona\` (e.g. coder/designer/default) — one-line description
2. [Subtask name] → assigned to \`persona\` (e.g. coder/designer/default) — one-line description
...

### Parallel Strategy
All-parallel | Sequential (1 then 2) | Mixed (1+2 parallel, 3 depends on 2)
</plan>

After writing <plan>, immediately start executing — **</plan> is NOT the end of your reply, it is the beginning of action.**

- If subtasks require tools (file ops, search, shell, API calls, etc.), call spawn_agent or use tools directly
- If remaining subtasks are pure text analysis and writing, just continue outputting results
- Key rule: do NOT stop at </plan> — either way, execute the plan through to completion. Describing a plan without acting means the user sees no progress.

**Spawning without a <plan> tag is a violation.** If the task is simple enough to not need a plan, it does not need spawn — handle it directly.

### Delegation Rules
1. Each child agent does ONE thing — task description must be specific and self-contained (child agents cannot see user messages or conversation history)
2. You may create up to ${max} child agents in parallel
3. After child agents complete, verify result quality — respawn if unsatisfactory

### Responding to User
Synthesize child agent results into one coherent, complete reply. **You are the ONLY point of contact with the user** — never let child agents talk to the user directly.

### Important Constraints
- Do NOT create child agents for trivial tasks — it wastes tokens and time
- If parallelism is unnecessary, spawn one child agent first, then decide next steps based on results
- Remember to use task_create / task_list / send_message for subtask management`,
      priority: PRIORITY_TEAM_MODE,
      cacheKey: 'team-mode',
      volatile: false,
    };
  }

  renderTemplate(template: string, vars: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, name) => vars[name] ?? `{{${name}}}`);
  }

  private buildChildModifierLayer(options: PromptAssemblyOptions): PromptLayer {
    const taskDesc =
      options.childTaskDescription ??
      'Execute the sub-task assigned by the primary agent and return results.';
    return {
      name: 'child-modifier',
      content: `You are a sub-agent spawned by the primary agent. Your only responsibility is to complete the assigned sub-task and return results to the primary agent. Do not attempt to manage long-term memory, create scheduled tasks, or initiate approvals — those are handled by the primary agent.
${taskDesc}`,
      priority: PRIORITY_CHILD_MODIFIER,
      cacheKey: 'child',
      volatile: true,
      blockTag: 'child',
    };
  }

  // ── Merge & Sort ────────────────────────────────────────────────────────────

  private mergeAndSort(layers: PromptLayer[], _options: PromptAssemblyOptions): string {
    const sorted = [...layers].sort((a, b) => a.priority - b.priority);

    // Deduplicate: same name → later overwrites earlier
    const seen = new Map<string, PromptLayer>();
    for (const layer of sorted) {
      seen.set(layer.name, layer);
    }
    const deduped = [...seen.values()].sort((a, b) => a.priority - b.priority);

    return deduped.map((l) => l.content).join('\n\n');
  }

  // ── Budget Trimming ─────────────────────────────────────────────────────────

  private trimToBudget(layers: PromptLayer[], maxTokens: number, warnings: string[]): string {
    const stable = layers.filter((l) => !l.volatile);
    const volatile = layers.filter((l) => l.volatile);

    const stableParts: string[] = stable
      .sort((a, b) => a.priority - b.priority)
      .map((l) => l.content);
    const volatileParts: string[] = volatile
      .sort((a, b) => a.priority - b.priority)
      .map((l) => l.content);

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
