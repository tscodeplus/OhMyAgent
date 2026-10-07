/**
 * Pure rules folding for test-log exact repetitions (phase-1 M1 decision point
 * `testlog.fold`, impl doc §4.2).
 *
 * Scans tool output for byte-identical repeated line blocks — the shape of
 * vitest / node:test / pytest failure dumps where the same diff, DOM dump or
 * stack appears once per re-run or per assertion. The FIRST copy is kept;
 * every later copy is replaced by ONE marker line that points back at the
 * original line range. No judge call — `features.testLogFold: 'rules'`.
 *
 * Deterministic and idempotent: folding folded output is a no-op (all later
 * copies are already gone, so no block repeats anymore).
 */

export interface FoldStats {
  /** Number of distinct repeated block groups detected. */
  blocks: number;
  /** Number of later copies replaced by a marker. */
  folded: number;
  /** text.length before minus after folding. */
  charsSaved: number;
}

export interface FoldResult {
  text: string;
  stats: FoldStats;
}

/** Marker appended for every folded later copy. Line numbers are 1-based and refer to the ORIGINAL text. */
export function foldMarkerLine(startLine: number, endLine: number): string {
  return `... identical to lines ${startLine}-${endLine} above (folded; full output archived).`;
}

/** Minimum repeated-block size: at least this many lines, or this many chars. */
const MIN_REPEAT_LINES = 8;
const MIN_REPEAT_CHARS = 400;
/** Safety valve for pathological inputs (massively repeated identical lines). */
const PROBE_BUDGET = 500_000;

/** Bookkeeping for one folded later copy: the original range of the kept first copy. */
interface FoldMarkerRange {
  startLine: number;
  endLine: number;
}

/**
 * Fold byte-identical repeated line blocks in `text`.
 *
 * Greedy longest-match from the first copy: for every line position (not yet
 * consumed by an earlier fold) the largest block whose line sequence reappears
 * later is folded; when it qualifies (>= 8 lines or >= 400 chars) all later
 * copies are replaced by one marker line each and scanning resumes after the
 * kept copy.
 */
export function foldTestLogBlocks(text: string): FoldResult {
  const lines = text.split('\n');
  const n = lines.length;
  if (n === 0) return { text, stats: { blocks: 0, folded: 0, charsSaved: 0 } };

  const replaced = new Array<boolean>(n).fill(false);
  /** Anchor line content → positions; candidates for a repeated copy must start on the same line. */
  const byContent = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const list = byContent.get(lines[i]!);
    if (list) list.push(i);
    else byContent.set(lines[i]!, [i]);
  }
  /** Position of a folded later copy → original 1-based range of the kept first copy. */
  const folds = new Map<number, FoldMarkerRange>();

  let probes = 0;
  const budgetExceeded = (): boolean => probes > PROBE_BUDGET;

  /** All positions j > start where lines[j..j+len) === the block at start. */
  const occurrencesAfter = (start: number, len: number): number[] => {
    const out: number[] = [];
    for (const j of byContent.get(lines[start]!) ?? []) {
      if (j <= start || replaced[j] || j + len > n) continue;
      probes++;
      if (budgetExceeded()) break;
      let same = true;
      for (let k = 1; k < len; k++) {
        if (lines[start + k] !== lines[j + k]) {
          same = false;
          break;
        }
      }
      if (same) out.push(j);
    }
    return out;
  };

  let blocks = 0;
  let folded = 0;
  let i = 0;
  while (i < n && !budgetExceeded()) {
    if (replaced[i]) {
      i++;
      continue;
    }
    // Longest block starting at i that reappears later (byte-identical lines).
    let bestLen = 0;
    let bestCopies: number[] = [];
    for (const j of byContent.get(lines[i]!) ?? []) {
      if (j <= i || replaced[j]) continue;
      let len = 0;
      while (i + len < n && j + len < n && lines[i + len] === lines[j + len]) {
        len++;
        probes++;
        if (budgetExceeded()) break;
      }
      if (budgetExceeded()) break;
      if (len <= bestLen) continue;
      const copies = occurrencesAfter(i, len);
      if (copies.length > 0) {
        bestLen = len;
        bestCopies = copies;
      }
      if (budgetExceeded()) break;
    }
    // Qualify: >= 8 lines, or >= 400 characters (line-content sum).
    let blockChars = 0;
    for (let k = 0; k < bestLen; k++) blockChars += lines[i + k]!.length;
    if (
      bestLen === 0 ||
      bestCopies.length === 0 ||
      (bestLen < MIN_REPEAT_LINES && blockChars < MIN_REPEAT_CHARS)
    ) {
      i++;
      continue;
    }
    // Fold every later copy (content lists are built in ascending order).
    for (const copyStart of bestCopies) {
      if (copyStart + bestLen > n) continue;
      let overlap = false;
      for (let k = 0; k < bestLen; k++) {
        if (replaced[copyStart + k]) {
          overlap = true;
          break;
        }
      }
      if (overlap) continue;
      replaced[copyStart] = true;
      for (let k = 1; k < bestLen; k++) replaced[copyStart + k] = true;
      folds.set(copyStart, { startLine: i + 1, endLine: i + bestLen });
      folded++;
    }
    blocks++;
    // Do not rescan inside or after the kept copy for this pass.
    i += bestLen;
  }

  if (folded === 0) {
    return { text, stats: { blocks: 0, folded: 0, charsSaved: 0 } };
  }

  const out: string[] = [];
  for (let line = 0; line < n; line++) {
    const fold = folds.get(line);
    if (fold) {
      out.push(foldMarkerLine(fold.startLine, fold.endLine));
      continue;
    }
    if (replaced[line]) continue; // covered by the marker pushed for this copy
    out.push(lines[line]!);
  }

  const foldedText = out.join('\n');
  return {
    text: foldedText,
    stats: { blocks, folded, charsSaved: text.length - foldedText.length },
  };
}
