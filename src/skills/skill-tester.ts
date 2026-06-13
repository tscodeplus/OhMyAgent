/**
 * Skill Tester — validates skill trigger matching and runtime behavior.
 *
 * Usage:
 *   const result = testSkillMatch(skill, message, toolNames);
 *   // → { matched, matchType, matchedTrigger, ... }
 */

import type { LoadedSkill } from './skill-loader.js';
import { resolveSkillContext } from './skill-router.js';
import { compileSkillContext } from './skill-compiler.js';
import { lintSkill, type LintResult } from './skill-linter.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SkillTestResult {
  /** Whether the test message matched this skill */
  matched: boolean;
  /** How the match occurred */
  matchType: 'explicit' | 'trigger' | 'none';
  /** The specific trigger word/phrase that matched (explicit match uses skill id) */
  matchedTrigger?: string;
  /** All triggers tested against the message */
  triggersTested: string[];
  /** Pre-compiled prompt layers that would be injected (preview) */
  promptLayerPreviews: Array<{ name: string; contentPreview: string; priority: number }>;
  /** Tool availability check */
  toolCheck: {
    allValid: boolean;
    unknownTools: string[];
  };
  /** Lint result for the skill */
  lintResult: LintResult;
  /** Human-readable diagnostic summary */
  diagnostic: string;
}

// ── Core ───────────────────────────────────────────────────────────────────────

/**
 * Test whether a skill matches a given message and report diagnostic info.
 *
 * @param skill - The loaded skill to test.
 * @param message - A test message to check trigger matching against.
 * @param toolNames - Names of all registered tools (for allowed-tools validation).
 */
export function testSkillMatch(
  skill: LoadedSkill,
  message: string,
  toolNames: string[],
): SkillTestResult {
  // 1. Resolve: does this skill match the message?
  const resolved = resolveSkillContext(message, [skill]);
  const matched = resolved.length > 0;
  const matchType = matched ? resolved[0]!.matchType : 'none';
  const matchedTrigger = matched ? resolved[0]!.matchedTrigger : undefined;

  // 2. Compile prompt layers for preview
  const compiled = compileSkillContext(resolved.length > 0 ? resolved : [{ skill, matchType: 'trigger', matchedTrigger: '' }]);
  const promptLayerPreviews = compiled.promptLayers.map(layer => ({
    name: layer.name,
    // Show first 200 chars of each layer as preview
    contentPreview: layer.content.length > 200
      ? layer.content.slice(0, 200) + '…'
      : layer.content,
    priority: layer.priority,
  }));

  // 3. Check tool availability
  const unknownTools = skill.tools.allowedTools.filter(t => !toolNames.includes(t));
  const toolCheck = {
    allValid: unknownTools.length === 0,
    unknownTools,
  };

  // 4. Lint
  const lintResult = lintSkill(skill, toolNames);

  // 5. Build diagnostic
  const diagnostic = buildDiagnostic(matched, matchType, matchedTrigger, skill, toolCheck, lintResult);

  return {
    matched,
    matchType,
    matchedTrigger,
    triggersTested: skill.manifest.triggers,
    promptLayerPreviews,
    toolCheck,
    lintResult,
    diagnostic,
  };
}

/**
 * Run a batch test against multiple test messages.
 */
export function testSkillBatch(
  skill: LoadedSkill,
  messages: string[],
  toolNames: string[],
): Array<{ message: string } & SkillTestResult> {
  return messages.map(message => ({
    message,
    ...testSkillMatch(skill, message, toolNames),
  }));
}

// ── Diagnostic Builder ─────────────────────────────────────────────────────────

function buildDiagnostic(
  matched: boolean,
  matchType: string,
  matchedTrigger: string | undefined,
  skill: LoadedSkill,
  toolCheck: { allValid: boolean; unknownTools: string[] },
  lintResult: LintResult,
): string {
  const lines: string[] = [];

  lines.push(`📋 Skill Tester Report: ${skill.manifest.name} (${skill.manifest.id})`);
  lines.push('');

  // Match status
  if (matched) {
    if (matchType === 'explicit') {
      lines.push(`✅ MATCHED (explicit — user typed $${skill.manifest.id} or /${skill.manifest.id})`);
    } else {
      lines.push(`✅ MATCHED (trigger: "${matchedTrigger}")`);
    }
  } else {
    lines.push('❌ NOT MATCHED');
    lines.push(`   Tested triggers: ${skill.manifest.triggers.join(', ')}`);
    lines.push(`   Message: none of the triggers appear in the test message`);
  }

  // Trigger info
  lines.push('');
  lines.push(`🔤 Triggers (${skill.manifest.triggers.length}): ${skill.manifest.triggers.join(', ')}`);

  // Tool check
  lines.push('');
  if (toolCheck.allValid) {
    lines.push('🔧 Tools: all allowed tools are registered ✅');
  } else {
    lines.push(`🔧 Tools: ${toolCheck.unknownTools.length} unknown tool(s): ${toolCheck.unknownTools.join(', ')} ⚠️`);
  }
  if (skill.tools.allowedTools.length > 0) {
    lines.push(`   Allowed: ${skill.tools.allowedTools.join(', ')}`);
  } else {
    lines.push('   Allowed: (none — inherits agent defaults)');
  }

  // Lint summary
  lines.push('');
  const errors = lintResult.issues.filter(i => i.level === 'error');
  const warnings = lintResult.issues.filter(i => i.level === 'warning');
  const infos = lintResult.issues.filter(i => i.level === 'info');
  if (lintResult.ok) {
    lines.push(`🔍 Lint: passed ✅ (${warnings.length} warning(s), ${infos.length} info)`);
  } else {
    lines.push(`🔍 Lint: ${errors.length} error(s), ${warnings.length} warning(s), ${infos.length} info`);
    for (const e of errors) {
      lines.push(`   ❌ [${e.rule}] ${e.message}`);
    }
  }

  // Prompt injection preview
  lines.push('');
  lines.push('📝 Prompt layers that would be injected:');
  const compiled = compileSkillContext([{ skill, matchType: matchType as any, matchedTrigger: matchedTrigger ?? '' }]);
  for (const layer of compiled.promptLayers) {
    const preview = layer.content.length > 100 ? layer.content.slice(0, 100) + '…' : layer.content;
    lines.push(`   [P${layer.priority}] ${layer.name}: "${preview}"`);
  }

  return lines.join('\n');
}
