/**
 * How the console prints a page's scope.
 *
 * The stored value is an address (`memory/knowledge/scope.ts` composes it from
 * the channel and the chat: `feishu:oc_1`, `telegram:session:s1`, `session:s1`),
 * so it reads as a machine id in a list. Folding the separator into `·` gives a
 * reviewer the two things they need — which channel, which chat — without the
 * full address taking over the row.
 *
 * `global` is deliberately not handled here: it is a state ("everyone can read
 * this"), not an address, and it has a translated label instead
 * (`knowledge.scopes.global`). See `KnowledgeScopeBadge`.
 */

/** `feishu:oc_1` → `feishu · oc_1`; `telegram:session:s1` → `telegram · session · s1`. */
export function compactScopeLabel(scope: string): string {
  return scope
    .split(':')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join(' · ');
}
