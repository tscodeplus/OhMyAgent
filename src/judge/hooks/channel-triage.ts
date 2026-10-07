/**
 * Hook for kernel M4 decision point `channel.triage` (impl doc §4.10): the
 * group-message entrance gate in the channel extensions (Feishu / Telegram /
 * QQ). The extensions already gate group chats on @-mention (or deliver only
 * mention events); this hook lets the judged triage override that baseline in
 * active mode, and stays byte-equal to the current behavior in shadow/off or
 * on any fallback (verdicts collapse to `defer` → `default` here).
 *
 * The task instruction is: mode shadow/off = current behavior; ledger
 * consistent (every non-off consult is ledgered by the engine).
 */

import { judgeChannelGroupTriage, type TriageDecision } from '../decisions/channel-triage.js';

export { CHANNEL_TRIAGE_POINT_ID } from '../decisions/channel-triage.js';
export { TRIAGE_LATENCY_BUDGET_MS } from '../decisions/channel-triage.js';

export type GroupGateDecision = 'respond' | 'silent' | 'default';

export interface GroupGateTriageInput {
  sessionId?: string;
  text: string;
  /** Caller-known mention signal (@-mention / reply-to bot), when any. */
  mentionedBot: boolean;
  logger?: {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
  };
}

export type GroupGateTriageResult = GroupGateDecision;

/**
 * Consult the judged group gate. Returns the gate decision the extension
 * must apply:
 *   - 'respond' (active mode only): proceed with the message even without
 *     the @-mention baseline;
 *   - 'silent'  (active mode only): stay silent on this group message even
 *     if it was addressed to the agent;
 *   - 'default': run the extension's existing gating rule unchanged.
 */
export async function triageGroupGateway(
  input: GroupGateTriageInput,
): Promise<GroupGateTriageResult> {
  let decision: TriageDecision;
  try {
    decision = await judgeChannelGroupTriage({
      sessionId: input.sessionId,
      text: input.text,
      mentionedBot: input.mentionedBot,
    });
  } catch (err) {
    input.logger?.debug({ err }, 'channel.triage consult failed — using default group gate');
    return 'default';
  }
  if (decision === 'respond') {
    input.logger?.info(
      { sessionId: input.sessionId },
      'channel.triage judged — responding to unaddressed group message',
    );
    return 'respond';
  }
  if (decision === 'silent') {
    input.logger?.info(
      { sessionId: input.sessionId },
      'channel.triage judged — staying silent on group message',
    );
    return 'silent';
  }
  return 'default';
}
