/**
 * Lightweight per-session agent context.
 * AgentService sets the agentId before each execute(), tools read it
 * to tag operations (memory writes, etc.) with the current agent.
 */
const sessionAgentMap = new Map<string, string>();

export function setSessionAgent(sessionId: string, agentId: string): void {
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

export function setDefaultAgentId(id: string | undefined): void {
  defaultAgentId = id;
}
