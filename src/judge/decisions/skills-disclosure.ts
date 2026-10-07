/**
 * Decision point `skills.disclosure` (phase-1 M1, plan §6 point 4, impl doc
 * §4.4): relevance double-check of trigger-word skill hits, batched as one
 * `decideMany` with one noul per candidate (keys s1..sN, shared state).
 *
 * Runs only when there is more than one candidate hit OR every hit is a weak
 * trigger (see {@link isWeakTriggerHit}). Skipped entirely for explicit
 * `$skill-id` commands, strict-surface skills and explicitTools turns — the
 * same "explicit surface decision" conditions the tool pipeline uses to skip
 * intent narrowing (src/agent/tool-pipeline.ts stage 3.7).
 *
 * Policy: a candidate is dropped only at P(keep) <= 0.1 (P(drop) >= 0.9);
 * gray keeps (engine cascades gray to the fallback anyway). Fallback =
 * `keep-all` — the current behavior, byte-equal.
 */

import { defineDecision, noul, type DecisionOutcome, type DecisionSpec } from '../types.js';
import type { ResolvedSkill } from '../../skills/skill-router.js';

export const SKILLS_DISCLOSURE_POINT_ID = 'skills.disclosure';

export interface SkillCandidate {
  /** Manifest id — also the outcome `keep(ids)` identity. */
  id: string;
  name: string;
  matchedTrigger?: string;
  /** Answer key for this candidate ("s1".."sN"). */
  key: string;
}

export interface SkillsDisclosureState {
  /** First 300 chars of the message. */
  messageExcerpt: string;
  candidates: SkillCandidate[];
}

/** Candidate keys are positional: s1..sN over the resolved order. */
export function skillCandidateKeys(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `s${i + 1}`);
}

/** Trigger hits this short are considered weak (hand-written single words / CJK one-shots). */
const WEAK_TRIGGER_MAX_CHARS = 3;

export function isWeakTriggerHit(trigger: string | undefined): boolean {
  return typeof trigger === 'string' && trigger.trim().length <= WEAK_TRIGGER_MAX_CHARS;
}

/** True when the resolved set qualifies for disclosure judging (multi-hit or all-weak). */
export function disclosureEligible(resolved: ResolvedSkill[]): boolean {
  if (resolved.length === 0) return false;
  if (resolved.length > 1) return true;
  return resolved.every((r) => isWeakTriggerHit(r.matchedTrigger));
}

/** Skip conditions mirrored from the tool pipeline's narrowing gates. */
export function disclosureSkipped(
  resolved: ResolvedSkill[],
  explicitToolsActive: boolean,
): string | undefined {
  if (resolved.length === 0) return 'no-candidates';
  if (resolved.some((r) => r.matchType === 'explicit')) return 'explicit-command';
  if (resolved.some((r) => r.skill.tools.surface === 'strict')) return 'strict-surface';
  if (explicitToolsActive) return 'explicit-tools';
  if (!disclosureEligible(resolved)) return 'not-eligible';
  return undefined;
}

const QUESTION_INSTRUCTIONS = (name: string): string =>
  `is skill ${name} relevant to this message?`;

function skillsDisclosurePolicy(
  answers: Record<string, unknown>,
  ctx: { input: { state: unknown } },
): DecisionOutcome {
  const state = (ctx.input.state ?? {}) as Partial<SkillsDisclosureState>;
  const candidates = Array.isArray(state.candidates) ? state.candidates : [];
  const dropped = new Set<string>();
  for (const candidate of candidates) {
    const answer = answers[String((candidate as SkillCandidate)?.key ?? '')] as
      { type?: string; probability?: number } | undefined;
    if (answer?.type === 'noul' && typeof answer.probability === 'number') {
      if (answer.probability <= 0.1) dropped.add(String((candidate as SkillCandidate).id));
    }
  }
  if (dropped.size === 0) return { action: 'keep-all' };
  return {
    action: 'keep',
    ids: candidates
      .map((c) => String((c as SkillCandidate).id))
      .filter((id) => id.length > 0 && !dropped.has(id)),
  };
}

const SKILLS_DISCLOSURE_FALLBACK: DecisionOutcome = { action: 'keep-all' };

/** Per-call spec: one noul per candidate, keyed by position, named by id. */
export function createSkillsDisclosureSpec(candidates: SkillCandidate[]): DecisionSpec {
  const questions: Record<string, DecisionSpec['questions'][string]> = {};
  for (const candidate of candidates) {
    questions[candidate.key] = noul(QUESTION_INSTRUCTIONS(candidate.name));
  }
  return defineDecision({
    id: SKILLS_DISCLOSURE_POINT_ID,
    version: 1,
    questions,
    buildState: (raw: unknown): SkillsDisclosureState => {
      // engine.decide passes the whole DecisionInput — unwrap `state`.
      const call = raw as { state?: unknown } | undefined;
      const input = ((call && typeof call === 'object' && 'state' in call ? call.state : raw) ??
        {}) as Partial<SkillsDisclosureState>;
      return {
        messageExcerpt:
          typeof input.messageExcerpt === 'string' ? input.messageExcerpt.slice(0, 300) : '',
        candidates: (Array.isArray(input.candidates) ? input.candidates : []).map((c) => ({
          id: String((c as SkillCandidate)?.id ?? ''),
          name: String((c as SkillCandidate)?.name ?? ''),
          matchedTrigger: (c as SkillCandidate)?.matchedTrigger,
          key: String((c as SkillCandidate)?.key ?? ''),
        })),
      };
    },
    policy: skillsDisclosurePolicy as DecisionSpec['policy'],
    fallback: SKILLS_DISCLOSURE_FALLBACK,
  });
}

/** Canonical registered instance (one-candidate template; hooks create per-call specs). */
export const skillsDisclosureSpec: DecisionSpec = createSkillsDisclosureSpec([
  { id: 'template', name: 'template', key: 's1' },
]);

export interface JudgeSkillsDisclosureResult {
  /** True when a judge call was made (shadow or active — ledger has a line). */
  asked: boolean;
  /**
   * `active` + judged only: the surviving candidate manifest ids. `undefined`
   * in every other case (shadow / fallback / skipped) — current behavior.
   */
  allowIds?: string[];
}

/**
 * Turn-start judged skill filter (hook, phase-1 M1). Awaited in the async turn
 * assembly flow BEFORE skill activation; the activation layer applies the
 * returned allow-set only when it is present (active + judged).
 *
 * STRICT no-op: engine absent or point mode 'off' → no call, no ledger line.
 */
export async function judgeSkillsDisclosure(input: {
  engine?: import('../engine.js').JudgeEngine;
  message: string;
  resolved: ResolvedSkill[];
  /** Channel-explicit tools active for this turn (skip). */
  explicitToolsActive: boolean;
  sessionId?: string;
}): Promise<JudgeSkillsDisclosureResult> {
  const engine = input.engine;
  if (!engine) return { asked: false };
  if (engine.modeFor(SKILLS_DISCLOSURE_POINT_ID) === 'off') return { asked: false };
  const skipped = disclosureSkipped(input.resolved, input.explicitToolsActive);
  if (skipped) return { asked: false };

  const keys = skillCandidateKeys(input.resolved.length);
  const candidates: SkillCandidate[] = input.resolved.map((r, index) => ({
    id: r.skill.manifest.id,
    name: r.skill.manifest.name,
    matchedTrigger: r.matchedTrigger,
    key: keys[index]!,
  }));
  const verdict = await engine.decideMany(createSkillsDisclosureSpec(candidates), {
    state: {
      messageExcerpt: input.message.slice(0, 300),
      candidates,
    },
    sessionId: input.sessionId,
  });
  if (verdict.source !== 'judge' || verdict.mode !== 'active') return { asked: true };
  if (verdict.outcome.action === 'keep') {
    return { asked: true, allowIds: verdict.outcome.ids };
  }
  if (verdict.outcome.action === 'keep-all') {
    // All judged — explicitly no filtering (identical to the current behavior).
    return { asked: true, allowIds: candidates.map((c) => c.id) };
  }
  return { asked: true };
}
