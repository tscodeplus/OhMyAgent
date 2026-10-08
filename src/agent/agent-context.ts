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

export function setTurnTaskHint(sessionId: string, taskHint: string): void {
  if (turnTaskHints.size >= MAX_TURN_TASK_HINTS && !turnTaskHints.has(sessionId)) {
    const first = turnTaskHints.keys().next().value;
    if (first !== undefined) turnTaskHints.delete(first);
  }
  turnTaskHints.set(sessionId, taskHint);
}

export function getTurnTaskHint(sessionId: string): string | undefined {
  return turnTaskHints.get(sessionId);
}

export function setDefaultAgentId(id: string | undefined): void {
  defaultAgentId = id;
}
