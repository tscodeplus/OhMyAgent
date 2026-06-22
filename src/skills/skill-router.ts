import type { LoadedSkill } from './skill-loader.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ResolvedSkill {
  skill: LoadedSkill;
  matchType: 'explicit' | 'trigger';
  matchedTrigger?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Compiled-regex caches. resolveSkillContext runs on EVERY inbound message and
// previously called `new RegExp(...)` for every trigger of every skill each
// time. Triggers are a small, stable set, so cache the compiled patterns keyed
// by their source string and reuse them across messages.
const explicitCommandCache = new Map<string, RegExp>();
const triggerCache = new Map<string, RegExp>();

/**
 * Check if a message contains a `$skill-id` token anywhere, or starts with `/skill-id`.
 * Returns true if the skill id is referenced via $ or / syntax.
 */
function matchExplicitCommand(message: string, skillId: string): boolean {
  let pattern = explicitCommandCache.get(skillId);
  if (!pattern) {
    // Match $skill-id anywhere OR /skill-id at the start of the message
    pattern = new RegExp(
      `(?:^/${escapeRegex(skillId)}(?:\\s|$))|(?:\\$${escapeRegex(skillId)}(?:\\s|$))`,
    );
    explicitCommandCache.set(skillId, pattern);
  }
  return pattern.test(message);
}

/**
 * Check if any trigger word appears in the message (case-insensitive, word boundary).
 * Returns the first matching trigger or undefined.
 */
function hasCJK(s: string): boolean {
  return /[一-鿿㐀-䶿　-〿＀-￯]/.test(s);
}

function triggerPattern(trigger: string): RegExp {
  let pattern = triggerCache.get(trigger);
  if (!pattern) {
    if (hasCJK(trigger)) {
      // CJK triggers: substring match (no \b — word boundaries don't work between hanzi)
      pattern = new RegExp(escapeRegex(trigger), 'i');
    } else {
      // ASCII triggers: word-boundary match.
      // Multi-word triggers allow 0–3 filler words (articles, determiners,
      // adjectives) between each pair of consecutive words. So "generate image"
      // matches "generate an image", "generate a nice image", "create a very
      // detailed beautiful image", etc.
      const words = trigger.split(/\s+/);
      if (words.length === 1) {
        pattern = new RegExp(`\\b${escapeRegex(words[0]!)}\\b`, 'i');
      } else {
        const segments = words.map((w) => `\\b${escapeRegex(w)}\\b`);
        // 0-3 intervening words per gap, e.g. articles + adjectives
        const filler = '(?:\\s+\\w+){0,3}';
        pattern = new RegExp(segments.join(`${filler}\\s+`), 'i');
      }
    }
    triggerCache.set(trigger, pattern);
  }
  return pattern;
}

function matchTrigger(message: string, triggers: string[]): string | undefined {
  for (const trigger of triggers) {
    if (triggerPattern(trigger).test(message)) {
      return trigger;
    }
  }
  return undefined;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Core ──────────────────────────────────────────────────────────────────────

/**
 * Resolve which skill(s) to activate based on user message.
 *
 * Resolution logic:
 * 1. Explicit command: message contains `$skill-id` or starts with `/skill-id`
 * 2. Trigger matching: trigger word appears in message (case-insensitive, word boundary)
 * 3. Disabled skills are excluded
 * 4. If any explicit match exists, trigger-based matches are dropped (explicit = user intent)
 * 5. Results sorted by priority (higher first)
 */
export function resolveSkillContext(
  message: string,
  skills: LoadedSkill[]
): ResolvedSkill[] {
  const results: ResolvedSkill[] = [];

  for (const skill of skills) {
    // Skip disabled skills
    if (!skill.manifest.enabled) {
      continue;
    }

    // Check explicit command ($skill-id or /skill-id)
    if (matchExplicitCommand(message, skill.manifest.id)) {
      results.push({
        skill,
        matchType: 'explicit',
        matchedTrigger: `$${skill.manifest.id}`,
      });
      continue;
    }

    // Check trigger matching
    const matchedTrigger = matchTrigger(message, skill.manifest.triggers);
    if (matchedTrigger !== undefined) {
      results.push({
        skill,
        matchType: 'trigger',
        matchedTrigger,
      });
    }
  }

  // If any explicit command matched, drop all trigger-based matches.
  // Explicit commands ($skill-id / /skill-id) represent clear user intent
  // and should not be diluted by incidental trigger matches.
  const hasExplicit = results.some(r => r.matchType === 'explicit');
  const filtered = hasExplicit
    ? results.filter(r => r.matchType === 'explicit')
    : results;

  // Sort by priority descending (higher priority first)
  filtered.sort((a, b) => b.skill.manifest.priority - a.skill.manifest.priority);

  return filtered;
}
