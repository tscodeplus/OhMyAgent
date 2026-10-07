/**
 * Decision-point registry (MyDocs plan §6 — the full 15-point catalog).
 *
 * `DECISION_POINTS` declares every planned point so the mode matrix and hook
 * points can agree on ids before their specs exist. `DECISION_SPECS` registers
 * the DecisionSpecs that phase-1 (M1) implemented so far — the other 11 are
 * declared but have no spec yet; `engine.modeFor()` still governs their matrix
 * entries and hook surfaces.
 *
 * Note on variable-arity specs (`tool.admission`, `skills.disclosure` and the
 * judged `testlog.fold` pass): their question sets depend on the caller's data
 * (chunks / candidates / blocks), so the registered instances are canonical
 * single-question templates and the hooks build per-call specs via the
 * `create*Spec` factories in the spec modules.
 */

import type { DecisionSpec } from '../types.js';
import { toolAdmissionSpec } from './tool-admission.js';
import { testLogFoldSpec } from '../testlog-fold.js';
import { intentClassifySpec } from './intent-classify.js';
import { skillsDisclosureSpec } from './skills-disclosure.js';

export interface DecisionPointInfo {
  id: string;
  /** Question shapes the point uses (rule = no judge call). */
  kind: 'noul' | 'choice' | 'score' | 'rule';
  label: string;
  description: string;
  /** True when a phase-1 DecisionSpec is implemented for this point. */
  implemented: boolean;
}

export const DECISION_POINTS: readonly DecisionPointInfo[] = [
  {
    id: 'tool.admission',
    kind: 'noul',
    label: 'Tool output chunk admission',
    description:
      'Judged admission of long tool results: one noul per chunk, evict at P(drop) ≥ 0.9 with a pointer line.',
    implemented: true,
  },
  {
    id: 'testlog.fold',
    kind: 'rule',
    label: 'Test log exact repetition folding',
    description:
      'Pure-rule folding of byte-identical repeated test-log blocks; the judged goal-aware pass runs only in features.testLogFold: jev.',
    implemented: true,
  },
  {
    id: 'intent.classify',
    kind: 'choice',
    label: 'Message intent domain',
    description:
      'Judge upgrade of the regex intent floor: choice over domains (+ other) and a thinkingNeed score, reconciled against the regex result.',
    implemented: true,
  },
  {
    id: 'skills.disclosure',
    kind: 'noul',
    label: 'Skill disclosure relevance filter',
    description:
      'Relevance noul per trigger-matched candidate skill when hits are multiple or weak; gray keeps the skill.',
    implemented: true,
  },
  {
    id: 'memory.capture',
    kind: 'noul',
    label: 'Memory capture worthiness',
    description: 'Is this message correcting the agent or setting a rule? Phase 2.',
    implemented: false,
  },
  {
    id: 'memory.worth',
    kind: 'choice',
    label: 'Memory lesson worth',
    description: 'useful-again / one-off / already-known for distilled lessons. Phase 2.',
    implemented: false,
  },
  {
    id: 'memory.merge',
    kind: 'choice',
    label: 'Memory merge relation',
    description:
      'duplicate / more-precise / contradicts / unrelated over top-k similar memories. Phase 2.',
    implemented: false,
  },
  {
    id: 'context.forget',
    kind: 'noul',
    label: 'Stale tool result eviction',
    description:
      'Outbound-context pruning of stale large tool results at the compaction watermark. Phase 2.',
    implemented: false,
  },
  {
    id: 'context.compact',
    kind: 'noul',
    label: 'Pre-compaction pruning',
    description: 'Judged pruning before the LLM summary compression path. Phase 2.',
    implemented: false,
  },
  {
    id: 'turn.drift',
    kind: 'noul',
    label: 'Turn drift detection',
    description:
      'Is the work still serving the original goal? failure-streak area of the agent loop. Phase 3.',
    implemented: false,
  },
  {
    id: 'turn.completion',
    kind: 'noul',
    label: 'Turn completion verification',
    description: 'Did the completion statement cite any verification? Phase 3.',
    implemented: false,
  },
  {
    id: 'tool.risk',
    kind: 'noul',
    label: 'Command explicitly requested',
    description:
      'Did the user explicitly ask for this command? Can only tighten the approval flow. Phase 3.',
    implemented: false,
  },
  {
    id: 'injection.screen',
    kind: 'noul',
    label: 'Prompt-injection screening',
    description:
      'Per-paragraph screening of web/MCP results for AI-directed instructions. Phase 3.',
    implemented: false,
  },
  {
    id: 'channel.triage',
    kind: 'choice',
    label: 'Group message triage',
    description: 'respond / ignore / defer for group-chat channel messages. Phase 4.',
    implemented: false,
  },
  {
    id: 'notify.routing',
    kind: 'choice',
    label: 'Notification routing',
    description: 'now / later / never routing for budget and status events. Phase 4.',
    implemented: false,
  },
];

export const DECISION_POINT_IDS: readonly string[] = DECISION_POINTS.map((p) => p.id);

/** Phase-1 registered specs (canonical templates for variable-arity points). */
export const DECISION_SPECS: Readonly<Record<string, DecisionSpec>> = {
  'tool.admission': toolAdmissionSpec,
  'testlog.fold': testLogFoldSpec,
  'intent.classify': intentClassifySpec,
  'skills.disclosure': skillsDisclosureSpec,
};

/** Spec for one point, when one is registered. */
export function decisionSpecFor(pointId: string): DecisionSpec | undefined {
  return DECISION_SPECS[pointId];
}
