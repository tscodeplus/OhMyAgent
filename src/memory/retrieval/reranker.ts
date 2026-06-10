import type { MergedResult } from '../rrf-merge.js';
import { extractSpeaker } from '../query-planner.js';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'you', 'your', 'was', 'were',
  'what', 'when', 'where', 'who', 'how', 'did', 'does', 'have', 'has', 'had',
  'from', 'about', 'into', 'can', 'could', 'would', 'should', 'there', 'their',
  'they', 'them', 'then', 'than', 'but', 'not', 'all', 'any', 'our', 'out',
]);

export interface RerankedResult extends MergedResult {
  rerankScore?: number;
}

export interface RerankOptions {
  /** Entity names whose own turns should be boosted (lowercased internally). */
  targetSpeakers?: string[];
  /** Additive boost applied when a result's speaker matches a target. Default 0.05. */
  speakerBoost?: number;
}

export function rerankMemoryResults(
  query: string,
  results: MergedResult[],
  options?: RerankOptions,
): MergedResult[] {
  if (results.length <= 1) return results;
  const queryTokens = tokenize(query);
  const queryNumbers = extractNumbers(query);
  const queryDates = extractDateTerms(query);
  const seenContext = new Map<string, number>();
  const targetSpeakers = options?.targetSpeakers?.length
    ? new Set(options.targetSpeakers.map(s => s.toLowerCase()))
    : undefined;
  const speakerBoost = options?.speakerBoost ?? 0.05;

  // Normalize the fused (RRF / coverage) score before adding lexical signals.
  // RRF contributions are tiny in absolute terms (single-source rank-0 ≈ 1/61 ≈
  // 0.016) while the lexical bonus below can reach ~0.5 — added raw, lexical
  // overlap dominates the sort and the vector / fusion signal becomes almost
  // irrelevant. We divide by the max (RRF scores are strictly positive) rather
  // than min-max: this is monotonic (preserves multi-source consensus ordering)
  // and keeps every score in (0,1], so it does NOT push the weakest candidate to
  // 0 — important because the caller applies a minScore floor AFTER reranking,
  // and a 0 would silently drop otherwise-valid recall. Lexical then refines
  // rather than overrides: a strong fusion gap (e.g. 1.0 vs 0.33) cannot be
  // erased by the capped lexical bonus.
  const maxFused = Math.max(...results.map(r => r.score));
  const fusedDivisor = maxFused > 0 ? maxFused : 1;

  return results
    .map((result, index) => {
      const contentTokens = tokenize(result.content);
      const contentTokenSet = new Set(contentTokens);
      const overlap = queryTokens.filter(token => contentTokenSet.has(token)).length;
      const rareOverlap = queryTokens
        .filter(token => token.length >= 6 && contentTokenSet.has(token)).length;
      const numberOverlap = intersectionSize(queryNumbers, extractNumbers(result.content));
      const dateOverlap = intersectionSize(queryDates, extractDateTerms(result.content));
      const kindBoost = kindPriority(result.kind);
      const contextKey = `${result.scope}:${result.scopeKey}:${result.kind}`;
      const duplicatePenalty = (seenContext.get(contextKey) ?? 0) * 0.015;
      seenContext.set(contextKey, (seenContext.get(contextKey) ?? 0) + 1);

      let speakerScore = 0;
      if (targetSpeakers) {
        const speaker = result.speaker ?? extractSpeaker(result.content);
        if (speaker && targetSpeakers.has(speaker.toLowerCase())) speakerScore = speakerBoost;
      }

      const normalizedFused = result.score / fusedDivisor;

      // Lexical bonus is capped so it stays a secondary refinement: even a perfect
      // lexical match cannot leapfrog a much stronger fusion signal on its own.
      const lexicalScore = Math.min(
        LEXICAL_BONUS_CAP,
        overlap * 0.045 +
          rareOverlap * 0.08 +
          numberOverlap * 0.12 +
          dateOverlap * 0.10 +
          kindBoost +
          speakerScore,
      );
      return {
        ...result,
        score: normalizedFused + lexicalScore - duplicatePenalty + 1 / ((index + 1) * 1000),
      };
    })
    .sort((a, b) => b.score - a.score);
}

/** Upper bound on the additive lexical refinement (vs normalized fused score ∈ (0,1]). */
const LEXICAL_BONUS_CAP = 0.5;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 2 && !STOPWORDS.has(token));
}

function extractNumbers(text: string): Set<string> {
  return new Set(text.match(/\b\d+(?:\.\d+)?\b/g) ?? []);
}

function extractDateTerms(text: string): Set<string> {
  const lower = text.toLowerCase();
  const terms = new Set<string>();
  for (const month of [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
    'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  ]) {
    if (lower.includes(month)) terms.add(month);
  }
  for (const weekday of [
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  ]) {
    if (lower.includes(weekday)) terms.add(weekday);
  }
  return terms;
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const value of a) {
    if (b.has(value)) count++;
  }
  return count;
}

function kindPriority(kind: string): number {
  if (kind === 'dialogue_turn') return 0.06;
  if (kind === 'dialogue_turn_window') return -0.03;
  if (kind === 'dialogue_session_summary') return -0.05;
  return 0;
}
