import { describe, it, expect, beforeEach } from 'vitest';
import { PromptManager } from '../../src/prompt/prompt-manager.js';
import { ChildAgentPromptOptimizer } from '../../src/prompt/child-agent-optimizer.js';
import type {
  PromptAssemblyResult,
  PromptLayer,
  PromptManagerDeps,
} from '../../src/prompt/types.js';

// ── Mock Helpers ───────────────────────────────────────────────────────────────

function createMockDeps(
  overrides?: Partial<PromptManagerDeps>,
): PromptManagerDeps {
  return { uiLanguage: 'en', contextWindow: 200_000, ...overrides };
}

/** Return the expected base-layer content (hardcoded English). */
function getBaseContent(): string {
  return [
    'You are OhMyAgent, a helpful AI assistant.',
    '',
    '## Memory',
    `You have long-term memory capabilities. Use the memory tools to manage information:
- **memory-store**: Save user preferences, facts, decisions, or anything worth remembering.
- **memory-recall**: Search your memory when you need context about the user or past conversations.
- **summarize-session**: When a discussion topic or task has reached a natural conclusion, call this to summarize the conversation into long-term memory.

**CRITICAL RULES — MUST FOLLOW:**
1. When the user shares the following, **immediately call memory-store** (do NOT just verbally acknowledge):
   - Their name or how they want to be addressed (e.g., "call me XX")
   - Your name or identity (e.g., "your name is XX")
   - Personal preferences, habits, devices, skills, etc.
2. Use memory-recall to search memory when you need context about the user or past discussions.
3. After completing complex tasks or multi-turn discussions, call summarize-session.

Example: User says "My name is Bob, call me Boss. Your name is Helper." → Immediately call memory-store twice: once for the user's name/preference, once for your name. Do not just reply "OK" without calling the tools.`,
    '',
    '## Scheduled Tasks (cronjob)',
    `You can create scheduled/reminder tasks using the **cronjob** tool. Use it when the user:
- Asks for a reminder (e.g., "remind me to check logs in 30 minutes")
- Requests periodic reports or messages (e.g., "send me a summary every morning at 9am")
- Wants delayed execution (e.g., "run this task in 5 minutes")

**CRITICAL: Create the cron job immediately, without asking clarifying questions.**

**The prompt parameter is key — it determines what the user ultimately sees.**
- prompt must be the final message the user will receive, written in natural language, e.g. "Time to read the news! Check out today's top stories"
- prompt is NOT an instruction for another agent — it IS the final message itself
- For pure reminders: write the reminder content directly, not in instruction format like "remind user to XXX"
- For information-gathering: write what to fetch, e.g. "Search for today's top AI news and summarize"

When the user says something like "remind me in X minutes about YYY":
  1. Call cronjob with action=create, name="Remind YYY", schedule="Xm", prompt="YYY"
  2. Then reply: "Reminder set for YYY in X minutes"
Do NOT ask how/when/frequency.

Schedule format examples:
- "5m" or "30m" = once after a delay (minutes/hours/days)
- "every 2h" or "every 1d" = repeat at fixed intervals
- "0 9 * * *" = cron expression (daily at 9:00)

Results are automatically delivered to this chat — you do NOT need to provide a chat_id.`,
  ].join('\n');
}

// ── PromptManager Tests ────────────────────────────────────────────────────────

describe('PromptManager', () => {
  let pm: PromptManager;
  let deps: PromptManagerDeps;

  beforeEach(() => {
    deps = createMockDeps();
    pm = new PromptManager(deps);
  });

  // ── assemble() ─────────────────────────────────────────────────────────────

  describe('assemble()', () => {
    it('returns base layer only when called with no options', () => {
      const result = pm.assemble();

      expect(result.layers).toHaveLength(1);
      expect(result.layers[0]).toMatchObject({
        name: 'base',
        priority: 0,
        cacheKey: 'base',
        volatile: false,
        blockTag: 'base',
      });
      expect(result.systemPrompt).toBe(getBaseContent());
      expect(result.tokenCount).toBeGreaterThan(0);
      expect(result.budgetWarnings).toEqual([]);
      expect(result.cacheBreakpoints).toHaveLength(1);
      expect(result.cacheBreakpoints[0]).toMatchObject({
        type: 'system',
        blockIndex: 0,
        label: 'base',
      });
    });

    it('includes registered agent override when agentId is provided', () => {
      pm.registerAgentOverride('researcher', 'You are a research assistant.');

      const result = pm.assemble({ agentId: 'researcher' });

      expect(result.layers).toHaveLength(2);
      const agentLayer = result.layers[1];
      expect(agentLayer.name).toBe('agent:researcher');
      expect(agentLayer.priority).toBe(50);
      expect(agentLayer.volatile).toBe(false);
      expect(agentLayer.cacheKey).toContain('agent:researcher');
      expect(result.systemPrompt).toContain('You are a research assistant.');
      expect(result.systemPrompt).toContain(getBaseContent());
    });

    it('returns null-like agent layer when agentId is given but no override registered and resolve returns empty', () => {
      // No registerAgentOverride called — resolveAgentPrompt returns '' → layer is null
      const result = pm.assemble({ agentId: 'ghost' });
      expect(result.layers).toHaveLength(1);
      expect(result.layers[0].name).toBe('base');
    });

    // Skill layers are no longer injected via system prompt (v7 redesign).
    // Skills are activated via $<id> fast path (system-reminder in conversation)
    // or intent matching (LLM reads SKILL.md via file_read).
    // The skillIds option is retained but produces no extra layers.

    it('includes child modifier layer when isChildAgent is true', () => {
      const result = pm.assemble({
        isChildAgent: true,
        childTaskDescription: 'Analyze the logs.',
      });

      expect(result.layers).toHaveLength(2); // base + child modifier
      expect(result.layers[1].name).toBe('child-modifier');
      expect(result.layers[1].priority).toBe(200);
      expect(result.layers[1].volatile).toBe(true);
      expect(result.systemPrompt).toContain('Analyze the logs.');
    });

    it('uses default task description when childTaskDescription is omitted', () => {
      const result = pm.assemble({ isChildAgent: true });

      const childLayer = result.layers.find(l => l.name === 'child-modifier')!;
      expect(childLayer.content).toContain('Execute the sub-task assigned by the primary agent and return results.');
    });

    it('child modifier layer uses rolePrefix as prefix', () => {
      const result = pm.assemble({
        isChildAgent: true,
        childTaskDescription: 'Do the thing.',
      });

      const content = result.layers.find(l => l.name === 'child-modifier')!.content;
      expect(content).toContain('You are a sub-agent spawned by the primary agent. Your only responsibility is to complete the assigned sub-task and return results to the primary agent. Do not attempt to manage long-term memory, create scheduled tasks, or initiate approvals — those are handled by the primary agent.');
      expect(content).toContain('Do the thing.');
    });

    it('deduplicates layers with the same name (later in priority order wins)', () => {
      // Register two agent overrides with same agentId → dedup picks later
      pm.registerAgentOverride('dup', 'first version');
      pm.registerAgentOverride('dup', 'second version');

      const result = pm.assemble({ agentId: 'dup' });
      const agentLayer = result.layers.find(l => l.name === 'agent:dup')!;
      expect(agentLayer.content).toBe('second version');
    });

    // ── L1 Skills Catalog ──────────────────────────────────────────────────────

    it('includes skills catalog layer when availableSkills has entries', () => {
      const result = pm.assemble({
        availableSkills: [
          { id: 'researcher', name: 'Researcher', description: 'Search and look up information.', path: 'skills/researcher/SKILL.md' },
          { id: 'code-review', name: 'Code Reviewer', description: 'Review code for bugs.', path: 'skills/code-review/SKILL.md' },
        ],
      });

      const catalogLayer = result.layers.find(l => l.name === 'skills-catalog');
      expect(catalogLayer).toBeDefined();
      expect(catalogLayer!.priority).toBe(25);
      expect(catalogLayer!.volatile).toBe(false);
      expect(catalogLayer!.cacheKey).toBe('skills-catalog');
      expect(catalogLayer!.blockTag).toBe('skills-catalog');
      // v7: compact catalog keeps trigger IDs and descriptions, not file paths
      expect(catalogLayer!.content).toContain('$researcher');
      expect(catalogLayer!.content).not.toContain('skills/researcher/SKILL.md');
      expect(catalogLayer!.content).toContain('$code-review');
      expect(catalogLayer!.content).not.toContain('skills/code-review/SKILL.md');
      expect(catalogLayer!.content).toContain('Search and look up information.');
    });

    it('omits skills catalog layer when availableSkills is empty array', () => {
      const result = pm.assemble({ availableSkills: [] });
      expect(result.layers.find(l => l.name === 'skills-catalog')).toBeUndefined();
    });

    it('omits skills catalog layer when availableSkills is undefined', () => {
      const result = pm.assemble({});
      expect(result.layers.find(l => l.name === 'skills-catalog')).toBeUndefined();
    });

    it('skills catalog layer is stable (non-volatile), survives token budget trimming', () => {
      // Use child modifier as a volatile layer that can be trimmed
      const result = pm.assemble({
        availableSkills: [{ id: 'researcher', name: 'R', description: 'D', path: 'skills/researcher/SKILL.md' }],
        isChildAgent: true,
        childTaskDescription: 'X'.repeat(100_000),
        maxTokens: 500,
      });

      // The catalog layer is volatile:false, so it should survive trimming
      expect(result.layers.find(l => l.name === 'skills-catalog')).toBeDefined();
      // The volatile child modifier layer should be trimmed
      expect(result.budgetWarnings.length).toBeGreaterThan(0);
    });

    it('single skill catalog format is correct', () => {
      const result = pm.assemble({
        availableSkills: [{ id: 'single', name: 'Single Skill', description: 'Does one thing well.', path: 'skills/single/SKILL.md' }],
      });

      const catalogLayer = result.layers.find(l => l.name === 'skills-catalog')!;
      expect(catalogLayer.content).toContain('Single Skill');
      expect(catalogLayer.content).toContain('$single');
      expect(catalogLayer.content).not.toContain('skills/single/SKILL.md');
      expect(catalogLayer.content).toContain('Does one thing well.');
    });

    it('multiple skills catalog includes all skills', () => {
      const skills = [
        { id: 'a', name: 'Alpha', description: 'First.', path: 'skills/a/SKILL.md' },
        { id: 'b', name: 'Beta', description: 'Second.', path: 'skills/b/SKILL.md' },
        { id: 'c', name: 'Gamma', description: 'Third.', path: 'skills/c/SKILL.md' },
      ];
      const result = pm.assemble({ availableSkills: skills });

      const catalogLayer = result.layers.find(l => l.name === 'skills-catalog')!;
      for (const s of skills) {
        expect(catalogLayer.content).toContain(s.name);
        expect(catalogLayer.content).toContain(s.description);
        expect(catalogLayer.content).toContain(`$${s.id}`);
        expect(catalogLayer.content).not.toContain(s.path);
      }
    });
  });

  // ── estimateTokens() ───────────────────────────────────────────────────────

  describe('estimateTokens()', () => {
    it('returns 0 for empty string', () => {
      expect(pm.estimateTokens('')).toBe(0);
    });

    it('estimates ASCII text at ~0.25 tokens per char', () => {
      // 4 ASCII chars → ceil(4 * 0.25) = ceil(1.0) = 1
      expect(pm.estimateTokens('abcd')).toBe(1);
      // 5 ASCII chars → ceil(5 * 0.25) = ceil(1.25) = 2
      expect(pm.estimateTokens('abcde')).toBe(2);
      // 8 ASCII chars → ceil(8 * 0.25) = ceil(2.0) = 2
      expect(pm.estimateTokens('abcdefgh')).toBe(2);
    });

    it('estimates CJK Unified text at ~0.5 tokens per char', () => {
      // 1 CJK char → ceil(1 * 0.5) = ceil(0.5) = 1
      expect(pm.estimateTokens('中')).toBe(1); // 中
      // 2 CJK chars → ceil(2 * 0.5) = 1
      expect(pm.estimateTokens('中国')).toBe(1); // 中国
      // 3 CJK chars → ceil(3 * 0.5) = ceil(1.5) = 2
      expect(pm.estimateTokens('中国人')).toBe(2); // 中国人
    });

    it('estimates CJK punctuation at ~0.5 tokens per char', () => {
      // U+3000 ideographic space, U+3001 ideographic comma
      expect(pm.estimateTokens('　')).toBe(1);
      expect(pm.estimateTokens('、。')).toBe(1); // 、。
    });

    it('estimates other Unicode at ~0.4 tokens per char', () => {
      // Emoji (U+1F600) → 0.4 per char
      expect(pm.estimateTokens('\u{1F600}')).toBe(1); // 1 char = ceil(0.4) = 1
      // 3 other-unicode chars → ceil(3 * 0.4) = ceil(1.2) = 2
      expect(pm.estimateTokens('€©®')).toBe(2); // €©®
    });

    it('estimates mixed content correctly', () => {
      // "hi" (2 ASCII = 0.5) + "中" (1 CJK = 0.5) = 1.0 → ceil = 1
      expect(pm.estimateTokens('hi中')).toBe(1);
      // "hello" (5 ASCII = 1.25) + "世界" (2 CJK = 1.0) = 2.25 → ceil = 3
      expect(pm.estimateTokens('hello世界')).toBe(3);
    });
  });

  // ── getCacheStrategy() ─────────────────────────────────────────────────────

  describe('getCacheStrategy()', () => {
    it('returns cache anchors for non-volatile layers only', () => {
      const layers: PromptLayer[] = [
        {
          name: 'base',
          content: 'base content',
          priority: 0,
          cacheKey: 'base',
          volatile: false,
        },
        {
          name: 'agent:researcher',
          content: 'agent content',
          priority: 50,
          cacheKey: 'agent:researcher:en',
          volatile: false,
        },
        {
          name: 'skill:code-review',
          content: 'skill content',
          priority: 100,
          cacheKey: 'skill:code-review',
          volatile: true,
        },
      ];

      const anchors = pm.getCacheStrategy(layers);

      expect(anchors).toHaveLength(2);
      expect(anchors[0]).toMatchObject({
        type: 'system',
        blockIndex: 0,
        label: 'base',
      });
      expect(anchors[1]).toMatchObject({
        type: 'system',
        blockIndex: 1,
        label: 'agent:researcher:en',
      });
    });

    it('skips volatile layers and does not increment blockIndex for them', () => {
      const layers: PromptLayer[] = [
        { name: 'base', content: 'b', priority: 0, cacheKey: 'base', volatile: false },
        { name: 'skill:a', content: 'a', priority: 100, cacheKey: 'skill:a', volatile: true },
        { name: 'skill:b', content: 'b', priority: 101, cacheKey: 'skill:b', volatile: true },
      ];

      const anchors = pm.getCacheStrategy(layers);

      // Only base is non-volatile
      expect(anchors).toHaveLength(1);
      expect(anchors[0].blockIndex).toBe(0);
      expect(anchors[0].label).toBe('base');
    });

    it('respects priority order for blockIndex assignment', () => {
      const layers: PromptLayer[] = [
        { name: 'skill:z', content: 'z', priority: 100, cacheKey: 'skill:z', volatile: true },
        { name: 'base', content: 'b', priority: 0, cacheKey: 'base', volatile: false },
        { name: 'agent:x', content: 'x', priority: 50, cacheKey: 'agent:x', volatile: false },
      ];

      const anchors = pm.getCacheStrategy(layers);

      // After sort: base (idx 0), agent:x (idx 1), skill:z (idx 2)
      expect(anchors).toHaveLength(2);
      expect(anchors[0].blockIndex).toBe(0);
      expect(anchors[0].label).toBe('base');
      expect(anchors[1].blockIndex).toBe(1);
      expect(anchors[1].label).toBe('agent:x');
    });
  });

  // ── renderTemplate() ───────────────────────────────────────────────────────

  describe('renderTemplate()', () => {
    it('replaces {{var}} placeholders with provided values', () => {
      const result = pm.renderTemplate('Hello {{name}}!', { name: 'World' });
      expect(result).toBe('Hello World!');
    });

    it('keeps unknown placeholders unchanged', () => {
      const result = pm.renderTemplate('Hello {{name}}!', {});
      expect(result).toBe('Hello {{name}}!');
    });

    it('handles templates with no variables', () => {
      const result = pm.renderTemplate('No variables here.', { foo: 'bar' });
      expect(result).toBe('No variables here.');
    });

    it('replaces multiple distinct variables', () => {
      const result = pm.renderTemplate('{{a}} + {{b}} = {{c}}', {
        a: '1',
        b: '2',
        c: '3',
      });
      expect(result).toBe('1 + 2 = 3');
    });

    it('replaces multiple occurrences of the same variable', () => {
      const result = pm.renderTemplate('{{x}}{{x}}{{x}}', { x: 'A' });
      expect(result).toBe('AAA');
    });
  });

  // ── register / invalidate agents ──────────────────────────────────────────

  describe('agent registration', () => {
    it('registerAgentOverride stores the prompt for later assembly', () => {
      pm.registerAgentOverride('helper', 'You are a helpful bot.');

      // First assemble finds it via cache
      const result1 = pm.assemble({ agentId: 'helper' });
      expect(result1.systemPrompt).toContain('You are a helpful bot.');

      // Override with new content
      pm.registerAgentOverride('helper', 'You are an even more helpful bot.');
      const result2 = pm.assemble({ agentId: 'helper' });
      expect(result2.systemPrompt).toContain('You are an even more helpful bot.');
    });

    it('invalidateAgentCache clears all language variants of an agent cache entry', () => {
      pm.registerAgentOverride('bot', 'Bot prompt.');
      pm.invalidateAgentCache('bot');

      // After invalidation, the cache is cleared; agent layer won't appear
      const result = pm.assemble({ agentId: 'bot' });
      expect(result.systemPrompt).not.toContain('Bot prompt.');
    });

    it('agent override can be re-registered after invalidation', () => {
      pm.registerAgentOverride('bot', 'Original.');
      pm.invalidateAgentCache('bot');

      // Re-register after invalidation
      pm.registerAgentOverride('bot', 'Updated.');
      const result = pm.assemble({ agentId: 'bot' });
      expect(result.systemPrompt).toContain('Updated.');
    });
  });

  // ── Token budget trimming ──────────────────────────────────────────────────

  describe('budget trimming', () => {
    /** Override base content with minimal strings for predictable token calculations. */
    function tinyMockDeps(): PromptManagerDeps {
      return { uiLanguage: 'en', contextWindow: 200_000 };
    }

    it('trims volatile layers when total exceeds maxTokens', () => {
      const manager = new PromptManager(tinyMockDeps());

      // Child modifier is volatile; with large task description it overshoots budget
      const result = manager.assemble({
        isChildAgent: true,
        childTaskDescription: 'X'.repeat(200),
        maxTokens: 15,
      });

      // Base survives (stable); child modifier (volatile) was trimmed
      expect(result.systemPrompt).toContain('You are OhMyAgent');
      expect(result.systemPrompt).not.toContain('X'.repeat(200));
      expect(result.budgetWarnings.length).toBeGreaterThanOrEqual(1);
      expect(result.budgetWarnings[0]).toContain('exceeds budget');
    });

    it('includes all layers when within budget', () => {
      const manager = new PromptManager(tinyMockDeps());

      // Very generous budget
      const result = manager.assemble({
        isChildAgent: true,
        childTaskDescription: 'tiny task',
        maxTokens: 10_000,
      });

      expect(result.budgetWarnings).toEqual([]);
      expect(result.layers).toHaveLength(2); // base + child modifier
    });

    it('generates a trim warning for each trimmed volatile layer', () => {
      const manager = new PromptManager(tinyMockDeps());

      // Child modifier is volatile and large → will be trimmed
      const result = manager.assemble({
        isChildAgent: true,
        childTaskDescription: 'X'.repeat(200),
        maxTokens: 5,
      });

      expect(result.budgetWarnings.length).toBeGreaterThanOrEqual(1);
      const trimWarnings = result.budgetWarnings.filter(w =>
        w.includes('Trimmed volatile layer'),
      );
      expect(trimWarnings.length).toBeGreaterThanOrEqual(1);
    });

    it('budget trimming preserves stable layers', () => {
      const manager = new PromptManager(tinyMockDeps());

      manager.registerAgentOverride('main', 'agent instructions.');

      // Extremely tight budget with child modifier as volatile
      const result = manager.assemble({
        agentId: 'main',
        isChildAgent: true,
        childTaskDescription: 'X'.repeat(200),
        maxTokens: 1,
      });

      // Stable layers (base + agent) still present
      expect(result.systemPrompt).toContain('You are OhMyAgent');
      expect(result.systemPrompt).toContain('agent instructions.');
      // Volatile layer (child modifier) is trimmed
      expect(result.systemPrompt).not.toContain('X'.repeat(200));
    });
  });

  // ── Assembly with all options combined ─────────────────────────────────────

  describe('combined assembly', () => {
    it('assembles base + agent + skills catalog + child modifier together', () => {
      pm.registerAgentOverride('agent-a', 'You are agent A.');

      const result = pm.assemble({
        agentId: 'agent-a',
        availableSkills: [{ id: 'skill-x', name: 'Skill X', description: 'X desc.', path: 'skills/skill-x/SKILL.md' }],
        isChildAgent: true,
        childTaskDescription: 'Do X and Y.',
      });

      // Priority order: base(0), skills-catalog(25), agent:a(50), child-modifier(200)
      expect(result.layers).toHaveLength(4);
      const names = result.layers.map(l => l.name);
      expect(names).toEqual([
        'base',
        'skills-catalog',
        'agent:agent-a',
        'child-modifier',
      ]);

      expect(result.systemPrompt).toContain(getBaseContent());
      expect(result.systemPrompt).toContain('You are agent A.');
      expect(result.systemPrompt).toContain('Skill X');
      expect(result.systemPrompt).toContain('$skill-x');
      expect(result.systemPrompt).toContain('Do X and Y.');
    });
  });

  // ── estimateTokens (edge cases) ────────────────────────────────────────────

  describe('estimateTokens edge cases', () => {
    it('handles surrogate pairs (emoji) correctly', () => {
      // U+1F600 😀 is a single char (codePoint > 0xFFFF)
      // It's > 0x7f and not in CJK ranges, so 0.4 tokens per char
      expect(pm.estimateTokens('\u{1F600}')).toBe(1); // ceil(1 * 0.4) = 1
    });

    it('handles very long strings without overflow', () => {
      const long = 'a'.repeat(10_000); // 10k ASCII chars
      const expected = Math.ceil(10_000 * 0.25);
      expect(pm.estimateTokens(long)).toBe(expected);
    });
  });

  // ── Default context / maxTokens ────────────────────────────────────────────

  describe('default budget calculation', () => {
    it('uses contextWindow * 0.3 as default maxTokens', () => {
      const smallPm = new PromptManager(createMockDeps({ contextWindow: 10000 }));
      // Default maxTokens = floor(10000 * 0.3) = 3000
      // Base content is ~2700 chars (under 3000 tokens)
      const result = smallPm.assemble();
      // Shouldn't trigger trimming with default budget
      expect(result.budgetWarnings).toEqual([]);
    });
  });
});

// ── ChildAgentPromptOptimizer Tests ────────────────────────────────────────────

describe('ChildAgentPromptOptimizer', () => {
  let optimizer: ChildAgentPromptOptimizer;

  beforeEach(() => {
    optimizer = new ChildAgentPromptOptimizer();
  });

  // ── Layer stripping ────────────────────────────────────────────────────────

  describe('layer stripping', () => {
    it('strips agent and skill layers, and content-strips base layer from parent assembly', () => {
      const parentAssembly: PromptAssemblyResult = {
        systemPrompt: '',
        layers: [
          mkLayer('base', 'Base instructions.', 0, 'base', false),
          mkLayer('agent:researcher', 'Agent instructions.', 50, 'agent:researcher:en', false),
          mkLayer('skill:code-review', 'Skill instructions.', 100, 'skill:code-review', true),
          mkLayer('custom-tool', 'Custom tool layer.', 150, 'custom-tool', false),
        ],
        tokenCount: 100,
        budgetWarnings: [],
        cacheBreakpoints: [],
      };

      const result = optimizer.optimize({
        parentAssembly,
        taskDescription: 'Review the code.',
      });

      const remainingNames = result.layers.map(l => l.name);
      // agent: and skill: layers are dropped entirely
      expect(remainingNames).not.toContain('agent:researcher');
      expect(remainingNames).not.toContain('skill:code-review');
      // base layer has content sections stripped but non-empty content
      // ("Base instructions." has no ## sections to strip) so it persists
      expect(remainingNames).toContain('base');
      // custom-tool does not match any pattern
      expect(remainingNames).toContain('custom-tool');
    });

    it('adds child-role layer at the front (highest priority)', () => {
      const parentAssembly: PromptAssemblyResult = {
        systemPrompt: '',
        layers: [mkLayer('custom', 'Custom.', 100, 'custom', false)],
        tokenCount: 10,
        budgetWarnings: [],
        cacheBreakpoints: [],
      };

      const result = optimizer.optimize({
        parentAssembly,
        taskDescription: 'Do something.',
      });

      const childRole = result.layers.find(l => l.name === 'child-role');
      expect(childRole).toBeDefined();
      expect(childRole!.priority).toBe(0);
      expect(result.layers[0].name).toBe('child-role');
    });

    it('strips content sections (Memory, Scheduled Tasks) from base layer', () => {
      const baseContent = [
        'You are an AI assistant.',
        '',
        '## Memory System',
        'You have memory access.',
        '',
        '## Scheduled Tasks',
        'You can run cron jobs.',
      ].join('\n');

      const parentAssembly: PromptAssemblyResult = {
        systemPrompt: '',
        layers: [mkLayer('base', baseContent, 0, 'base', false)],
        tokenCount: 30,
        budgetWarnings: [],
        cacheBreakpoints: [],
      };

      const result = optimizer.optimize({
        parentAssembly,
        taskDescription: 'Do a task.',
      });

      const remainingBase = result.layers.find(l => l.name === 'base');
      // Base should be processed and stripped but still present (had non-empty content after stripping)
      expect(remainingBase).toBeDefined();
      expect(remainingBase!.content).not.toContain('## Memory System');
      expect(remainingBase!.content).not.toContain('## Scheduled Tasks');
      expect(remainingBase!.content).toContain('You are an AI assistant');
    });

    it('strips Chinese 记忆系统 and 定时任务 content from base layer (legacy)', () => {
      const baseContent = [
        'I am an AI assistant.',
        '',
        '## 记忆系统',
        'Memory content here.',
        '',
        '## 定时任务',
        'Cron content here.',
      ].join('\n');

      const parentAssembly: PromptAssemblyResult = {
        systemPrompt: '',
        layers: [mkLayer('base', baseContent, 0, 'base', false)],
        tokenCount: 20,
        budgetWarnings: [],
        cacheBreakpoints: [],
      };

      const result = optimizer.optimize({
        parentAssembly,
        taskDescription: 'Execute task.',
      });

      const remainingBase = result.layers.find(l => l.name === 'base');
      expect(remainingBase).toBeDefined();
      expect(remainingBase!.content).not.toContain('记忆系统');
      expect(remainingBase!.content).not.toContain('定时任务');
      expect(remainingBase!.content).toContain('I am an AI assistant');
    });

    it('drops the base layer entirely when content is empty after stripping', () => {
      const baseContent = [
        '## Memory System',
        'memory stuff.',
        '',
        '## Scheduled Tasks',
        'cron stuff.',
      ].join('\n');

      const parentAssembly: PromptAssemblyResult = {
        systemPrompt: '',
        layers: [mkLayer('base', baseContent, 0, 'base', false)],
        tokenCount: 10,
        budgetWarnings: [],
        cacheBreakpoints: [],
      };

      const result = optimizer.optimize({
        parentAssembly,
        taskDescription: 'task',
      });

      const remainingBase = result.layers.find(l => l.name === 'base');
      expect(remainingBase).toBeUndefined();
    });

    it('preserves layers that do not match any strip pattern', () => {
      const parentAssembly: PromptAssemblyResult = {
        systemPrompt: '',
        layers: [
          mkLayer('custom-layer', 'Custom content.', 50, 'custom', false),
          mkLayer('another-layer', 'More content.', 60, 'another', false),
        ],
        tokenCount: 20,
        budgetWarnings: [],
        cacheBreakpoints: [],
      };

      const result = optimizer.optimize({
        parentAssembly,
        taskDescription: 'task',
      });

      expect(result.layers.map(l => l.name)).toContain('custom-layer');
      expect(result.layers.map(l => l.name)).toContain('another-layer');
    });
  });

  // ── keepBlocks ─────────────────────────────────────────────────────────────

  describe('keepBlocks option', () => {
    it('keeps specified blocks even if they match strip patterns', () => {
      const parentAssembly: PromptAssemblyResult = {
        systemPrompt: '',
        layers: [
          mkLayer('base', 'Base instructions.', 0, 'base', false),
          mkLayer('agent:gpt', 'Agent override.', 50, 'agent:gpt:en', false),
        ],
        tokenCount: 20,
        budgetWarnings: [],
        cacheBreakpoints: [],
      };

      // keepBlocks matches by layer.name or blockTag
      const opt = new ChildAgentPromptOptimizer();
      const result = opt.optimize({
        parentAssembly,
        taskDescription: 'task',
        keepBlocks: ['agent:gpt'],
      });

      const remainingNames = result.layers.map(l => l.name);
      // agent:gpt is kept because it's in keepBlocks
      expect(remainingNames).toContain('agent:gpt');
      // base is content-stripped but its content is non-empty, so it persists
      expect(remainingNames).toContain('base');
    });

    it('keeps blocks by blockTag when name does not match', () => {
      const layer: PromptLayer = {
        name: 'some-name',
        content: 'Content.',
        priority: 50,
        cacheKey: 'agent:special:en',
        volatile: false,
        blockTag: 'agent:special',
      };

      const parentAssembly: PromptAssemblyResult = {
        systemPrompt: '',
        layers: [layer],
        tokenCount: 5,
        budgetWarnings: [],
        cacheBreakpoints: [],
      };

      // Match by blockTag rather than name
      const result = optimizer.optimize({
        parentAssembly,
        taskDescription: 'task',
        keepBlocks: ['agent:special'],
      });

      expect(result.layers.map(l => l.name)).toContain('some-name');
    });
  });

  // ── Result structure ───────────────────────────────────────────────────────

  describe('result structure', () => {
    it('returns a valid PromptAssemblyResult with correct properties', () => {
      const parentAssembly: PromptAssemblyResult = {
        systemPrompt: '',
        layers: [
          mkLayer('base', 'Base.', 0, 'base', false),
          mkLayer('custom', 'Custom.', 50, 'custom', false),
        ],
        tokenCount: 10,
        budgetWarnings: [],
        cacheBreakpoints: [],
      };

      const result = optimizer.optimize({
        parentAssembly,
        taskDescription: 'A task.',
      });

      expect(result).toHaveProperty('systemPrompt');
      expect(result).toHaveProperty('layers');
      expect(result).toHaveProperty('tokenCount');
      expect(result).toHaveProperty('budgetWarnings');
      expect(result).toHaveProperty('cacheBreakpoints');
      expect(typeof result.systemPrompt).toBe('string');
      expect(Array.isArray(result.layers)).toBe(true);
      expect(typeof result.tokenCount).toBe('number');
      expect(Array.isArray(result.budgetWarnings)).toBe(true);
      expect(Array.isArray(result.cacheBreakpoints)).toBe(true);
    });

    it('sets budgetWarnings and cacheBreakpoints to empty arrays', () => {
      const parentAssembly: PromptAssemblyResult = {
        systemPrompt: '',
        layers: [mkLayer('custom', 'C.', 50, 'c', false)],
        tokenCount: 1,
        budgetWarnings: [],
        cacheBreakpoints: [],
      };

      const result = optimizer.optimize({
        parentAssembly,
        taskDescription: 'task',
      });

      expect(result.budgetWarnings).toEqual([]);
      expect(result.cacheBreakpoints).toEqual([]);
    });

    it('sorts layers by priority in the output', () => {
      const parentAssembly: PromptAssemblyResult = {
        systemPrompt: '',
        layers: [
          mkLayer('layer-c', 'CCC', 200, 'c', false),
          mkLayer('layer-a', 'AAA', 50, 'a', false),
          mkLayer('layer-b', 'BBB', 100, 'b', false),
        ],
        tokenCount: 30,
        budgetWarnings: [],
        cacheBreakpoints: [],
      };

      const result = optimizer.optimize({
        parentAssembly,
        taskDescription: 'task',
      });

      const priorities = result.layers.map(l => l.priority);
      // child-role is added at priority 0, and remaining layers should be sorted
      for (let i = 1; i < priorities.length; i++) {
        expect(priorities[i]).toBeGreaterThanOrEqual(priorities[i - 1]);
      }
    });
  });

  // ── Child role layer content ───────────────────────────────────────────────

  describe('child role content', () => {
    it('includes task description in ## Task section', () => {
      const parentAssembly: PromptAssemblyResult = {
        systemPrompt: '',
        layers: [mkLayer('custom', 'C.', 50, 'c', false)],
        tokenCount: 1,
        budgetWarnings: [],
        cacheBreakpoints: [],
      };

      const result = optimizer.optimize({
        parentAssembly,
        taskDescription: 'Analyze the dataset and return insights.',
      });

      const childRole = result.layers.find(l => l.name === 'child-role')!;
      expect(childRole.content).toContain('## Task');
      expect(childRole.content).toContain('Analyze the dataset and return insights.');
      // Child role uses i18n; with default mock t, the key appears as-is
      expect(childRole.content).toContain('You are a sub-agent spawned by the primary agent.');
    });
  });

  // ── Blank line cleanup ─────────────────────────────────────────────────────

  describe('content cleanup', () => {
    it('replaces 3+ consecutive newlines with double newlines', () => {
      const baseContent = 'Header.\n\n\n\n\nTrailer.';
      const parentAssembly: PromptAssemblyResult = {
        systemPrompt: '',
        layers: [mkLayer('base', baseContent, 0, 'base', false)],
        tokenCount: 5,
        budgetWarnings: [],
        cacheBreakpoints: [],
      };

      const result = optimizer.optimize({
        parentAssembly,
        taskDescription: 'task',
      });

      const remaining = result.layers.find(l => l.name === 'base');
      expect(remaining).toBeDefined();
      expect(remaining!.content).not.toContain('\n\n\n');
    });

    it('trims leading and trailing whitespace', () => {
      const baseContent = '  \n\n## Memory System\nstuff\n\n## Scheduled Tasks\nmore\n\n  ';
      const parentAssembly: PromptAssemblyResult = {
        systemPrompt: '',
        layers: [mkLayer('base', baseContent, 0, 'base', false)],
        tokenCount: 5,
        budgetWarnings: [],
        cacheBreakpoints: [],
      };

      const result = optimizer.optimize({
        parentAssembly,
        taskDescription: 'task',
      });

      const remaining = result.layers.find(l => l.name === 'base');
      if (remaining) {
        // Should not have leading/trailing whitespace after trim
        expect(remaining.content).toBe(remaining.content.trim());
      }
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty parent assembly layers', () => {
      const parentAssembly: PromptAssemblyResult = {
        systemPrompt: '',
        layers: [],
        tokenCount: 0,
        budgetWarnings: [],
        cacheBreakpoints: [],
      };

      const result = optimizer.optimize({
        parentAssembly,
        taskDescription: 'task',
      });

      expect(result.layers).toHaveLength(1);
      expect(result.layers[0].name).toBe('child-role');
      expect(result.systemPrompt).toContain('## Task');
    });

    it('handles parent assembly with only a base layer', () => {
      const parentAssembly: PromptAssemblyResult = {
        systemPrompt: '',
        layers: [mkLayer('base', 'You are an AI.', 0, 'base', false)],
        tokenCount: 5,
        budgetWarnings: [],
        cacheBreakpoints: [],
      };

      const result = optimizer.optimize({
        parentAssembly,
        taskDescription: 'task',
      });

      // Base is stripped (matched by /^base$/i), but its content after section
      // stripping may or may not remain. "You are an AI." has no ## sections
      // to strip, so it should persist.
      expect(result.layers.map(l => l.name)).toContain('base');
      expect(result.layers.map(l => l.name)).toContain('child-role');
    });

    it('custom strip patterns work via constructor', () => {
      const customOptimizer = new ChildAgentPromptOptimizer([/^custom-/]);
      const parentAssembly: PromptAssemblyResult = {
        systemPrompt: '',
        layers: [
          mkLayer('custom-foo', 'Should be stripped.', 10, 'custom-foo', false),
          mkLayer('keep-me', 'Should remain.', 20, 'keep-me', false),
        ],
        tokenCount: 5,
        budgetWarnings: [],
        cacheBreakpoints: [],
      };

      const result = customOptimizer.optimize({
        parentAssembly,
        taskDescription: 'task',
      });

      expect(result.layers.map(l => l.name)).not.toContain('custom-foo');
      expect(result.layers.map(l => l.name)).toContain('keep-me');
      expect(result.layers.map(l => l.name)).toContain('child-role');
    });
  });
});

// ── Factory Helper ─────────────────────────────────────────────────────────────

function mkLayer(
  name: string,
  content: string,
  priority: number,
  cacheKey: string,
  volatile: boolean,
  blockTag?: string,
): PromptLayer {
  return { name, content, priority, cacheKey, volatile, blockTag };
}
