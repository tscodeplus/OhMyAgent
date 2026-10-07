/**
 * Decision-point registry (MyDocs plan §6 — the full 15-point catalog).
 *
 * `DECISION_POINTS` declares every planned point so the mode matrix and hook
 * points can agree on ids. `DECISION_SPECS` registers the implemented
 * DecisionSpecs — M1 (tool token economy), M2/M3 (memory, context stock and
 * safety) and M4 (the two phase-4 channel points `channel.triage` and
 * `notify.routing`).
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
import { memoryCaptureSpec } from './memory-capture.js';
import { memoryWorthSpec } from './memory-worth.js';
import { memoryMergeSpec } from './memory-merge.js';
import { contextForgetSpec } from './context-forget.js';
import { contextCompactSpec } from './context-compact.js';
import { turnDriftSpec } from './turn-drift.js';
import { turnCompletionSpec } from './turn-completion.js';
import { toolRiskSpec } from './tool-risk.js';
import { injectionScreenSpec } from './injection-screen.js';
import { channelTriageSpec } from './channel-triage.js';
import { notifyRoutingSpec } from './notify-routing.js';

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
    description:
      'Is this message correcting the agent or setting a rule? Gating judged capture candidates (M2, src/memory).',
    implemented: true,
  },
  {
    id: 'memory.worth',
    kind: 'choice',
    label: 'Memory lesson worth',
    description:
      'useful-again / one-off / already-known for judged capture candidates — only useful-again persists (M2).',
    implemented: true,
  },
  {
    id: 'memory.merge',
    kind: 'choice',
    label: 'Memory merge relation',
    description:
      'duplicate / more-precise / contradicts / unrelated against the similar existing memory (M2, replaces the aux-LLM merge question).',
    implemented: true,
  },
  {
    id: 'context.forget',
    kind: 'noul',
    label: 'Stale tool result eviction',
    description:
      'Outbound-context pruning of stale large tool results at the compaction watermark (M2, src/agent/context-transform.ts).',
    implemented: true,
  },
  {
    id: 'context.compact',
    kind: 'noul',
    label: 'Pre-compaction pruning',
    description:
      'Judged pruning before the LLM summary compression path; may skip the LLM summary entirely (M2, features.compact: judged).',
    implemented: true,
  },
  {
    id: 'turn.drift',
    kind: 'noul',
    label: 'Turn drift detection',
    description:
      'Is the work still serving the original goal? Injected via the first-party prepareNextTurn hook (M3).',
    implemented: true,
  },
  {
    id: 'turn.completion',
    kind: 'noul',
    label: 'Turn completion verification',
    description:
      'Did the completion statement cite any verification? One follow-up nudge at most per turn (M3).',
    implemented: true,
  },
  {
    id: 'tool.risk',
    kind: 'noul',
    label: 'Command explicitly requested',
    description:
      'Did the user explicitly ask for this command? Tighten-only: may force an approval card, never auto-approve (M3).',
    implemented: true,
  },
  {
    id: 'injection.screen',
    kind: 'noul',
    label: 'Prompt-injection screening',
    description:
      'Per-paragraph screening of web/MCP results for AI-directed instructions (M3, tool-result ingestion).',
    implemented: true,
  },
  {
    id: 'channel.triage',
    kind: 'choice',
    label: 'Group message triage',
    description:
      'respond / ignore / defer at the group-chat entrance, gated on an addressed noul; hook: channel extension group gates, budget-capped at 1s (M4).',
    implemented: true,
  },
  {
    id: 'notify.routing',
    kind: 'choice',
    label: 'Notification routing',
    description:
      'now / later / never routing of proactive notifications before CronDeliveryRegistry delivery; fallback = immediate delivery (M4).',
    implemented: true,
  },
];

export const DECISION_POINT_IDS: readonly string[] = DECISION_POINTS.map((p) => p.id);

/** Registered specs (canonical templates for variable-arity points). */
export const DECISION_SPECS: Readonly<Record<string, DecisionSpec>> = {
  'tool.admission': toolAdmissionSpec,
  'testlog.fold': testLogFoldSpec,
  'intent.classify': intentClassifySpec,
  'skills.disclosure': skillsDisclosureSpec,
  'memory.capture': memoryCaptureSpec,
  'memory.worth': memoryWorthSpec,
  'memory.merge': memoryMergeSpec,
  'context.forget': contextForgetSpec,
  'context.compact': contextCompactSpec,
  'turn.drift': turnDriftSpec,
  'turn.completion': turnCompletionSpec,
  'tool.risk': toolRiskSpec,
  'injection.screen': injectionScreenSpec,
  'channel.triage': channelTriageSpec,
  'notify.routing': notifyRoutingSpec,
};

/** Spec for one point, when one is registered. */
export function decisionSpecFor(pointId: string): DecisionSpec | undefined {
  return DECISION_SPECS[pointId];
}
