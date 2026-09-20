/**
 * Convert to LLM
 *
 * Filters agent messages to only those compatible with the LLM API:
 * system, user, assistant, and toolResult messages.
 *
 * `system` messages must pass through: since pi-mono v0.86.0 the system prompt
 * and tool declarations are carried by transcript system messages, so dropping
 * them would strip the prompt and every tool from the request.
 */

/**
 * Convert agent messages to LLM-compatible format.
 *
 * @param messages - Array of agent messages.
 * @returns Filtered array containing only system, user, assistant, and toolResult messages.
 */
export function convertToLlm(messages: any[]): any[] {
  return messages.filter(
    (m) =>
      m.role === 'system' || m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult',
  );
}
