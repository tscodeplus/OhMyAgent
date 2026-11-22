/**
 * Lightweight per-session agent context.
 * AgentService sets the agentId before each execute(), tools read it
 * to tag operations (memory writes, etc.) with the current agent.
 */
const sessionAgentMap = new Map<string, string>();
const MAX_SESSION_AGENT_ENTRIES = 500;

export function setSessionAgent(sessionId: string, agentId: string): void {
  // Refresh insertion order and evict the oldest inactive mapping so this
  // module-level lookup cannot outlive AgentService's bounded session cache.
  sessionAgentMap.delete(sessionId);
  while (sessionAgentMap.size >= MAX_SESSION_AGENT_ENTRIES) {
    const oldest = sessionAgentMap.keys().next().value;
    if (oldest === undefined) break;
    sessionAgentMap.delete(oldest);
  }
  sessionAgentMap.set(sessionId, agentId);
}

export function getSessionAgent(sessionId: string): string | undefined {
  return sessionAgentMap.get(sessionId);
}

export function clearSessionAgent(sessionId: string): void {
  sessionAgentMap.delete(sessionId);
}

/** Default agentId when no session/agent mapping exists. */
export let defaultAgentId: string | undefined;

// ─── Jev judgment kernel (phase-1 M1): turn task-hint store ───

/**
 * First-chunk of the current turn's user message per session, read by the
 * tool.admission hook when the judged state is built ("does the current task
 * still need this chunk?"). Capped like the other session maps so a
 * long-running gateway cannot grow it without bound.
 */
const turnTaskHints = new Map<string, string>();
const MAX_TURN_TASK_HINTS = 500;

/**
 * Last few user turns per session (newest last), written alongside the single
 * task hint above. Read by the tool.risk judge state: "did the user explicitly
 * ask for this operation" cannot be answered from the current turn's first 200
 * characters alone, which is why that point hedged into the gray band on most
 * calls.
 */
const recentUserTurns = new Map<string, string[]>();
/** Turns kept per session (the judge state caps this again on its side). */
export const MAX_RECENT_USER_TURNS = 4;
const RECENT_TURN_CHARS = 200;

export function setTurnTaskHint(sessionId: string, taskHint: string): void {
  if (turnTaskHints.size >= MAX_TURN_TASK_HINTS && !turnTaskHints.has(sessionId)) {
    const first = turnTaskHints.keys().next().value;
    if (first !== undefined) turnTaskHints.delete(first);
  }
  turnTaskHints.set(sessionId, taskHint);
  // Same event, one call site: keep the bounded history in step with the hint.
  const history = recentUserTurns.get(sessionId) ?? [];
  history.push(taskHint.slice(0, RECENT_TURN_CHARS));
  if (history.length > MAX_RECENT_USER_TURNS)
    history.splice(0, history.length - MAX_RECENT_USER_TURNS);
  recentUserTurns.delete(sessionId);
  recentUserTurns.set(sessionId, history);
  while (recentUserTurns.size > MAX_TURN_TASK_HINTS) {
    const oldest = recentUserTurns.keys().next().value;
    if (oldest === undefined) break;
    recentUserTurns.delete(oldest);
  }
}

export function getTurnTaskHint(sessionId: string): string | undefined {
  return turnTaskHints.get(sessionId);
}

/**
 * Recent user turns, oldest first. A COPY — callers (the judge state builder)
 * must not be able to mutate the store.
 */
export function getRecentUserTurns(sessionId: string): string[] {
  return [...(recentUserTurns.get(sessionId) ?? [])];
}

/**
 * Drop the per-turn context of a session (task hint + recent turns). Called
 * when the conversation itself is cleared: turns from a history that no longer
 * exists must not become evidence for the next judge call.
 */
export function clearTurnContext(sessionId: string): void {
  turnTaskHints.delete(sessionId);
  recentUserTurns.delete(sessionId);
}

export function setDefaultAgentId(id: string | undefined): void {
  defaultAgentId = id;
}
