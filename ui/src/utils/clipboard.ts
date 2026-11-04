/**
 * Copy text, including where the Clipboard API does not exist.
 *
 * `navigator.clipboard` is gated on a secure context. The phone-facing UI is served
 * over plain HTTP on a LAN address (`http://192.168.x.x:9191`), where the property is
 * simply missing, so `await navigator.clipboard.writeText(...)` threw a TypeError and
 * the old `catch {}` turned every copy button in the app into a no-op — the command
 * copy on a note or a draft card looked clickable and did nothing. The hidden-textarea
 * `execCommand('copy')` path still works without a secure context, so it is the
 * fallback rather than an afterthought.
 *
 * Returns whether the text actually reached the clipboard, so callers draw their
 * "copied" tick from the result instead of reporting a refused copy as a success.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Denied by a permissions policy, or the document is not focused; fall through.
    }
  }
  return copyWithTextarea(text);
}

function copyWithTextarea(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const area = document.createElement('textarea');
  area.value = text;
  // Off-screen but *not* `display:none` / `opacity:0`: iOS refuses to copy from an
  // element it considers invisible, and a 16px font stops the page zooming on focus.
  area.setAttribute('readonly', '');
  area.style.cssText =
    'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;margin:-1px;' +
    'border:0;outline:0;box-shadow:none;background:transparent;color:transparent;font-size:16px;';
  // The caret has to leave and come back: `select()` collapses the reader's own
  // selection, and losing it is how "copy" ends up feeling destructive.
  const selection = document.getSelection();
  const savedRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  // `focus()` on the helper would otherwise throw the reader's focus (and, on a phone,
  // the scroll position) at the top of the page.
  const previousFocus = document.activeElement;
  document.body.appendChild(area);
  let copied = false;
  try {
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, text.length);
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    area.remove();
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
      previousFocus.focus({ preventScroll: true });
    }
    if (savedRange && selection) {
      selection.removeAllRanges();
      selection.addRange(savedRange);
    }
  }
  return copied;
}
