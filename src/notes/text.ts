/**
 * The two text facts the notes layer has to answer the same way everywhere.
 *
 * Both used to exist twice. `estimateTokens` lived in `window.ts` and
 * `estimateNoteTokens` in `capture.ts`, with different CJK ranges — so the ledger's
 * `token_est` and the window's `tokenEst` could describe one conversation as two
 * different costs. "The first line that says something" existed in `capture.ts`
 * (`titleFromText`) and `distill.ts` (`firstLine`), with different fallbacks. A second
 * copy of a rule is not a formatting problem: it is the same material measured two
 * ways, and nothing on screen says which number a row or a title came from.
 *
 * Pure string functions, no database and no model: that is what lets `capture.ts`,
 * `window.ts` and `distill.ts` share them without a dependency cycle.
 */

/**
 * Rough token estimate, for accounting only: CJK ~2 chars/token, latin ~4.
 *
 * The CJK ranges are the **union** of the two sets this layer used to run separately —
 * `window.ts` had `U+3000–U+9FFF`, `U+F900–U+FAFF` and `U+FF00–U+FFEF`; `capture.ts` had
 * `U+3400–U+9FFF`, `U+3040–U+30FF` and `U+AC00–U+D7AF` — which comes out as CJK
 * punctuation and fullwidth forms, kana, ideographs (including extension A and the
 * compatibility block) and Hangul syllables.
 *
 * Union rather than intersection, because the two errors are not symmetric. A
 * character charged as CJK that is really latin makes the number a little cautious;
 * a CJK character charged as latin makes it a quarter of its cost. And the failure
 * this function exists to prevent is the *disagreement* itself: the same window
 * priced 800 tokens by `resolveWindow` and 600 by the capture ledger is a bug nobody
 * can see, because both numbers are only ever displayed as "this is roughly how big
 * the material was". `token_est` is accounting, never a budget — no cap reads it — so
 * a cautious estimate costs nothing, while two answers to one question cost trust.
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (
      (code >= 0x3000 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.ceil(cjk / 2 + other / 4);
}

/**
 * What `firstMeaningfulLine` answers when the text holds no line of its own: nothing.
 *
 * One constant, because the two callers used to answer differently (`'随手记'` for a
 * dropped text's title, `''` for a distilled note's summary) and neither could tell
 * which shape the other stored. It is the *empty* string rather than a placeholder
 * because an empty answer is the true one — the material contains no words — and a
 * name invented here would read as something someone wrote. The browser editor reached
 * the same conclusion for the same reason (`NotesView.tsx#firstLineOf`: a library
 * filling with untitled notes nobody can tell apart is what a made-up name produces).
 */
const NO_LINE = '';

/**
 * The first line that says something, with leading markdown furniture stripped.
 *
 * A dropped text and a model-written body both start with `##`/`-`/`>` about as often
 * as they start with a word, and the first line is the cheapest honest title there is.
 *
 * Not capped here: the title is cut at 60 characters and the summary at 120
 * (`distill.ts` → `LIMITS.summaryMax`), and a cap shared by both would have to be the
 * smaller of the two, silently shortening every summary.
 *
 * There is a third copy in `ui/src/components/notes/NotesView.tsx#firstLineOf`, and it
 * stays a copy: it runs in the browser bundle, where the notes layer's server modules
 * (`better-sqlite3`, `pino`, the aux model client) cannot be imported. Change one,
 * change the other — they only have to agree on what "a line with words" looks like,
 * which is this regex.
 */
export function firstMeaningfulLine(text: string, fallback: string = NO_LINE): string {
  for (const item of text.split('\n')) {
    const line = item.replace(/^[#>*\-\s]+/, '').trim();
    if (line.length > 0) return line;
  }
  return fallback;
}
