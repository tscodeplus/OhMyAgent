/**
 * Convert to LLM
 *
 * Filters agent messages to only those compatible with the LLM API:
 * user, assistant, and toolResult messages.
 */

/**
 * Convert agent messages to LLM-compatible format.
 *
 * @param messages - Array of agent messages.
 * @returns Filtered array containing only user, assistant, and toolResult messages.
 */
export function convertToLlm(messages: any[]): any[] {
  return messages.filter(
    (m) => m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult',
  );
}
