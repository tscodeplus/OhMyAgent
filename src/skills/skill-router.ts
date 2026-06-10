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
 * Check if a message contains a `$skill-id` token anywhere.
 * Returns true if the skill id is referenced via $ syntax.
 */
function matchExplicitDollarCommand(message: string, skillId: string): boolean {
  let pattern = explicitCommandCache.get(skillId);
  if (!pattern) {
    pattern = new RegExp(`\\$${escapeRegex(skillId)}(?:\\s|$)`);
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
    // CJK triggers: substring match (no \b — word boundaries don't work between hanzi)
    // ASCII triggers: word-boundary match
    pattern = hasCJK(trigger)
      ? new RegExp(escapeRegex(trigger), 'i')
      : new RegExp(`\\b${escapeRegex(trigger)}\\b`, 'i');
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
 * 1. Explicit command: message starts with `/skill-id`
 * 2. Trigger matching: trigger word appears in message (case-insensitive, word boundary)
 * 3. Disabled skills are excluded
 * 4. Results sorted by priority (higher first)
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

    // Check $ explicit command
    if (matchExplicitDollarCommand(message, skill.manifest.id)) {
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

  // Sort by priority descending (higher priority first)
  results.sort((a, b) => b.skill.manifest.priority - a.skill.manifest.priority);

  return results;
}
