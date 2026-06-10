/**
 * Truncate text to a maximum length, appending ellipsis if truncated.
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

/**
 * Truncate tool output with a header showing truncation info.
 */
export function truncateToolOutput(output: string, maxLength: number): string {
  if (output.length <= maxLength) return output;
  const truncated = output.slice(0, maxLength);
  const remaining = output.length - maxLength;
  return `${truncated}\n\n[Output truncated: ${remaining} characters omitted]`;
}
