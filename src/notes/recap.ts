/**
 * The recap gate: a rule-based check for the most common bad output (plan §5.4).
 *
 * The failure mode is not "the model wrote something wrong", it is "the model
 * wrote a summary of the conversation". A recap looks fine in a review card and is
 * worthless later, because it answers "what did we talk about" instead of "what do
 * I know now".
 *
 * The test is a 4-gram Jaccard overlap against the source window: text that
 * restates the window shares most of its 4-grams with it, while a real note
 * states the conclusion in its own words (or quotes one command, which is a small
 * fraction of the window). Free — no model call, no tokens, and testable.
 *
 * Two guards keep it from killing good notes:
 *   - Tags present → not a recap. A distiller that produced tags classified the
 *     content, which a summariser does not do.
 *   - Short bodies are exempt: a 20-word note cannot share 60% of a 2000-word
 *     window, but it also cannot be summarising it.
 */

/** Below this many body characters the ratio is noise, not a signal. */
const MIN_BODY_CHARS = 120;
/** Jaccard similarity above which a body is treated as a restatement. */
const RECAP_THRESHOLD = 0.6;
const NGRAM = 4;

/** Character 4-grams, whitespace-insensitive. Works for CJK without a tokenizer. */
export function ngramSet(text: string, size = NGRAM): Set<string> {
  const normalized = text.replace(/\s+/g, '').toLowerCase();
  const grams = new Set<string>();
  for (let index = 0; index + size <= normalized.length; index += 1) {
    grams.add(normalized.slice(index, index + size));
  }
  return grams;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const gram of small) if (large.has(gram)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export interface RecapInput {
  body: string;
  tags: readonly string[];
  /** The window the note was distilled from, as one string. */
  windowText: string;
}

export interface RecapVerdict {
  recap: boolean;
  /** For the diagnostic log — the ratio the decision was made on. */
  score: number;
}

export function isRecap(input: RecapInput): RecapVerdict {
  const body = input.body.trim();
  if (body.length < MIN_BODY_CHARS) return { recap: false, score: 0 };
  if (input.tags.length > 0) return { recap: false, score: 0 };

  const score = jaccard(ngramSet(body), ngramSet(input.windowText));
  return { recap: score > RECAP_THRESHOLD, score };
}
