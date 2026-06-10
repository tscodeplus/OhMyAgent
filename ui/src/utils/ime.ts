/**
 * Returns true when a keyboard event should NOT be treated as an Enter
 * confirmation because the user is still composing text (CJK/IME input).
 *
 * Usage:
 *   onKeyDown(e) {
 *     if (e.key === 'Enter' && !isImeEnterEvent(e)) {
 *       commit();
 *     }
 *   }
 */
export function isImeEnterEvent(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}
