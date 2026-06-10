/**
 * Answer-level judge (eval-only) — measures whether retrieved context is good
 * enough to actually answer a question, not just whether the gold turn ranked.
 *
 * Two stages, both LLM with a deterministic lexical fallback:
 *   1. generateAnswer(query, contexts)  — answer from RETRIEVED context ONLY.
 *      Gold answers/evidence are NEVER passed here; doing so would leak the
 *      target into generation and inflate the score.
 *   2. judgeAnswer(query, generated, gold) — compare the generated answer to
 *      the gold answer and return correct/incorrect + a short reason.
 *
 * Both stages no-op gracefully (return a `skipped` verdict) when no aux model
 * is configured, so the eval still runs offline.
 */

import type { Logger } from 'pino';
import type { AuxModelConfig } from '../aux-llm-client.js';
import { auxLLMCall } from '../aux-llm-client.js';

export interface JudgeConfig {
  auxConfig?: AuxModelConfig;
  /** Max retrieved contexts fed to the generator. Default 10. */
  maxContexts: number;
  /** Max chars per context snippet. Default 600. */
  maxContextChars: number;
  logger: Logger;
}

export type AnswerVerdict = 'correct' | 'incorrect' | 'partial' | 'skipped';

export interface AnswerJudgeResult {
  verdict: AnswerVerdict;
  /** Model-generated answer from retrieved context (empty when skipped). */
  generatedAnswer: string;
  /** Short rationale from the judge, or the fallback method used. */
  reason: string;
  /** True when a real LLM produced the judgement (vs. lexical fallback). */
  llmJudged: boolean;
}

const GEN_SYSTEM_PROMPT =
  'You answer a question using ONLY the numbered context snippets provided. ' +
  'If the context does not contain the answer, reply exactly "INSUFFICIENT". ' +
  'Answer in one short sentence. Do not invent facts beyond the context.';

const JUDGE_SYSTEM_PROMPT =
  'You grade a predicted answer against the gold answer for the same question. ' +
  'Output ONLY compact JSON {"verdict": "correct"|"incorrect"|"partial", "reason": "<=12 words"}. ' +
  'Judge semantic equivalence, not wording. "partial" = right entity but missing/extra detail.';

function hasModel(config: JudgeConfig): boolean {
  return Boolean(config.auxConfig?.modelRef || (config.auxConfig?.fallbackRefs?.length ?? 0) > 0);
}

/** Build the numbered-context user prompt for the generator. */
function buildContextPrompt(query: string, contexts: string[], config: JudgeConfig): string {
  const snippets = contexts
    .slice(0, config.maxContexts)
    .map((c, i) => `[${i + 1}] ${c.slice(0, config.maxContextChars)}`)
    .join('\n');
  return `Context:\n${snippets}\n\nQuestion: ${query}\nAnswer:`;
}

/**
 * Generate an answer from retrieved context ONLY.
 * Never receives the gold answer. Returns 'INSUFFICIENT' (or '' when skipped).
 */
export async function generateAnswer(
  query: string,
  contexts: string[],
  config: JudgeConfig,
): Promise<string> {
  if (!hasModel(config) || contexts.length === 0) return '';
  try {
    const answer = await auxLLMCall(config.auxConfig!, {
      systemPrompt: GEN_SYSTEM_PROMPT,
      userPrompt: buildContextPrompt(query, contexts, config),
      temperature: 0,
      maxTokens: 120,
      logger: config.logger,
    });
    return answer.trim();
  } catch {
    config.logger.warn('answer generation failed');
    return '';
  }
}

const STOP = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'of', 'to', 'in', 'on', 'at',
  'and', 'or', 'for', 'with', 'it', 'they', 'he', 'she', 'that', 'this', 'as',
]);

function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(t => t.length > 1 && !STOP.has(t)),
  );
}

/** Deterministic lexical overlap fallback when no judge model is available. */
function lexicalVerdict(generated: string, gold: string): { verdict: AnswerVerdict; reason: string } {
  const g = generated.trim();
  if (!g || /^insufficient$/i.test(g)) return { verdict: 'incorrect', reason: 'lexical: empty/insufficient' };
  const goldTokens = tokenize(gold);
  if (goldTokens.size === 0) return { verdict: 'incorrect', reason: 'lexical: empty gold' };
  const genTokens = tokenize(g);
  let overlap = 0;
  for (const t of goldTokens) if (genTokens.has(t)) overlap++;
  const recall = overlap / goldTokens.size;
  if (recall >= 0.8) return { verdict: 'correct', reason: `lexical recall ${recall.toFixed(2)}` };
  if (recall >= 0.4) return { verdict: 'partial', reason: `lexical recall ${recall.toFixed(2)}` };
  return { verdict: 'incorrect', reason: `lexical recall ${recall.toFixed(2)}` };
}

function parseJudgeResponse(raw: string): { verdict: AnswerVerdict; reason: string } | null {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    const v = typeof obj.verdict === 'string' ? obj.verdict.trim().toLowerCase() : '';
    if (v !== 'correct' && v !== 'incorrect' && v !== 'partial') return null;
    const reason = typeof obj.reason === 'string' ? obj.reason.slice(0, 120) : '';
    return { verdict: v as AnswerVerdict, reason };
  } catch {
    return null;
  }
}

/**
 * Full answer-level judgement: generate from context, then grade vs gold.
 * Falls back to lexical overlap for the grading step when no judge model
 * is available, so an offline run still produces a verdict.
 */
export async function judgeAnswer(
  query: string,
  contexts: string[],
  goldAnswer: string,
  config: JudgeConfig,
): Promise<AnswerJudgeResult> {
  const generatedAnswer = await generateAnswer(query, contexts, config);

  // No generation possible (no model / no context) → skip rather than penalize.
  if (!generatedAnswer) {
    return { verdict: 'skipped', generatedAnswer: '', reason: 'no answer generated', llmJudged: false };
  }

  if (hasModel(config)) {
    try {
      const response = await auxLLMCall(config.auxConfig!, {
        systemPrompt: JUDGE_SYSTEM_PROMPT,
        userPrompt: `Question: ${query}\nGold answer: ${goldAnswer}\nPredicted answer: ${generatedAnswer}`,
        temperature: 0,
        maxTokens: 80,
        logger: config.logger,
      });
      const parsed = parseJudgeResponse(response);
      if (parsed) {
        return { ...parsed, generatedAnswer, llmJudged: true };
      }
      config.logger.warn('judge returned unparseable output, using lexical fallback');
    } catch {
      config.logger.warn('judge call failed, using lexical fallback');
    }
  }

  const fallback = lexicalVerdict(generatedAnswer, goldAnswer);
  return { ...fallback, generatedAnswer, llmJudged: false };
}

