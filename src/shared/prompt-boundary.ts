/**
 * Prompt boundary neutralization (review #10: "no trust boundary").
 *
 * Dynamic context — recalled memories, the task canvas, archived tool results,
 * the persona block — is appended into tagged sections of the *same* user
 * message as the conversation. Those tags are the only signal telling the model
 * "this came from the gateway, not from the chat", and every one of them is
 * predictable. A fetched page or file containing `</archived_tool_results>`
 * followed by `<system>…` therefore closes our section and opens one the model
 * reads as authoritative.
 *
 * Dropping the angle brackets of reserved tag names keeps the text readable
 * while making it unable to forge a boundary. Ordinary markup, code samples and
 * unrelated XML pass through untouched.
 */

const RESERVED_TAG_PATTERN =
  /<\/?(?:memory_context|persona|task_progress|archived_tool_results|system-reminder|system|instructions?)\b[^<>]*>/gi;
const ANGLE_BRACKETS = /[<>]/g;

function stripBrackets(tag: string): string {
  return tag.replace(/^<\/?/, '').replace(/>$/, '');
}

/** Remove gateway tag sequences that untrusted text could use to fake a boundary. */
export function neutralizePromptTags(text: string): string {
  if (!text.includes('<')) return text;

  let current = text;
  for (let pass = 0; pass < 4; pass++) {
    const next = current.replace(RESERVED_TAG_PATTERN, stripBrackets);
    // Stable means no reserved tag survives — the common case, and normal text
    // with its own markup exits here unchanged.
    if (next === current) return current;
    current = next;
  }
  // Still changing after four passes: brackets are reassembling into a reserved
  // tag (`<<system>>` and friends). Drop every bracket rather than guess.
  return current.replace(ANGLE_BRACKETS, '');
}
