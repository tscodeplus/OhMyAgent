/**
 * Distillation: turn a conversation window into candidate notes (plan §5.3).
 *
 * One model call, low temperature, aux model by default (`notes.capture.modelRef`
 * overrides). Extraction is throughput work and wants a fast non-reasoning model —
 * the same argument `memory.entity_extraction.model` already carries.
 *
 * The prompt's job is to prevent two failure modes, in this order:
 *   1. **Recap** — "the user asked X, then the assistant did Y". The 4-gram gate
 *      (`recap.ts`) catches it after the fact; the prompt is the first line.
 *   2. **Invention** — a plausible flag, path or version nobody said. Quotes are
 *      required (`evidence` must be a message id from the window), and the body
 *      may not go beyond what the window supports.
 *
 * Validation is **fail-closed per note, not per batch** (plan §5.3): one bad note
 * must not discard three good ones. Rules that are about the *note* drop the note;
 * only a completely unusable response makes the capture `invalid`.
 */

import type { Logger } from 'pino';
import { auxLLMCall, type AuxModelConfig } from '../memory/aux-llm-client.js';
import { extractJson } from '../memory/json-utils.js';
import { normalizeTags } from './canonical.js';
import { NOTE_FIELDS, isNoteKind, type NoteField, type NoteKind } from './types.js';

/** Caps from the plan §5.3 validation table. */
const LIMITS = {
  titleMax: 60,
  summaryMax: 120,
  bodyMax: 600,
  tagsMax: 6,
  fieldsValueMax: 400,
} as const;

export interface DistilledNote {
  kind: NoteKind;
  title: string;
  summary: string;
  body: string;
  fields: NoteField[];
  tags: string[];
  /** Window message ids this note rests on. Non-empty for agent drafts. */
  evidence: string[];
  confidence: number | null;
}

export interface DistillRejection {
  reason:
    | 'invalid_json'
    | 'not_object'
    | 'unknown_kind'
    | 'too_long'
    | 'empty'
    | 'evidence_outside_window'
    | 'no_evidence';
  /** Short diagnostic, never the note body (it may contain a secret). */
  detail: string;
}

export interface DistillOutcome {
  notes: DistilledNote[];
  rejected: DistillRejection[];
  /** Raw model output length, for the diagnostic log. */
  rawChars: number;
}

/**
 * The system prompt. Kept in one template literal so the validation rules and
 * the instructions are read side by side during review.
 */
export const DISTILL_SYSTEM_PROMPT = `你是「笔记蒸馏器」。用户刚刚做完一段工作，想从中提炼出以后能复用的东西。

只产出「下次还会用到的知识」：
- command   一条具体命令/参数/一行式，必须能原样复制执行
- workflow  一套顺序步骤，含判断是否跑通的检查点
- pitfall   踩过的坑：现象→根因→修法→如何避免
- insight   原理性启发，一句话断言 + 为什么
- opinion   值得收藏的判断，注明谁说的
- reference 模型/API/配置怎么调、参数含义、限制
- decision  决定 + 背景 + 放弃的选项

硬规则：
1. 不要复述对话，不要写「用户询问了…然后助手回答…」。
2. 每条必须引用 evidence（材料里括号里的 id），不能引用材料以外的 id。
3. 没有值得记的就返回 {"notes": []}——允许零条，绝不允许凑数。
4. body ≤ 600 字，用 markdown；命令放在 \`\`\` 代码块里。
5. 权威信息缺失时宁可不写，不要猜参数、猜版本、猜路径。
6. 不要包含密钥、cookie、个人隐私；发现疑似密钥就不要写进 body。
7. 模板是提示，不是表单。上面的 kind 与槽位只是帮你分类，填不满就只写 body；
   一条笔记不像任何模板但确实值得留，就用 kind="other"，不要为了套模板而删掉内容。
8. 只记结论，不记过程。材料里没有的结论，不要替用户补出来。

输出严格 JSON：
{"notes":[{"kind":"command","title":"≤60字","summary":"≤120字一行","body":"markdown","fields":{"command":"…","when":"…"},"tags":["kebab-case"],"evidence":["<材料里的 id>"],"confidence":0.8}]}`;

function clampText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Slug-ish tag cleanup shared with the repository: the distiller is asked for
 * kebab-case, but a model that returns `#Testing` or `feishu card` must not put a
 * differently-shaped tag in the same column the user's own tags live in.
 */
function normalizeFieldValue(value: unknown): string {
  if (typeof value === 'string') return clampText(value, LIMITS.fieldsValueMax);
  if (Array.isArray(value)) {
    return clampText(
      value
        .map((item) => (typeof item === 'string' ? item.trim() : String(item)))
        .filter(Boolean)
        .join('\n'),
      LIMITS.fieldsValueMax,
    );
  }
  return '';
}

/** Which slots are copied, and in which order the UI renders them. */
function buildFields(kind: NoteKind, raw: unknown): NoteField[] {
  if (!raw || typeof raw !== 'object') return [];
  const allowed = NOTE_FIELDS[kind];
  const record = raw as Record<string, unknown>;
  const fields: NoteField[] = [];
  for (const key of allowed) {
    const value = normalizeFieldValue(record[key]);
    if (!value) continue;
    // `command`/`usage`/`subject` are things people copy; the rest is prose.
    fields.push({ key, value, mono: key === 'command' || key === 'usage' || key === 'subject' });
  }
  return fields;
}

/**
 * Validate one candidate. Returns `null` and pushes a rejection when the note is
 * unusable.
 */
function validateNote(
  raw: unknown,
  allowedEvidence: Set<string>,
  rejected: DistillRejection[],
): DistilledNote | null {
  if (!raw || typeof raw !== 'object') {
    rejected.push({ reason: 'not_object', detail: 'candidate is not an object' });
    return null;
  }
  const candidate = raw as Record<string, unknown>;

  const kind = isNoteKind(candidate.kind) ? candidate.kind : null;
  if (!kind) {
    rejected.push({ reason: 'unknown_kind', detail: String(candidate.kind ?? 'missing') });
    return null;
  }

  const title = clampText(candidate.title, LIMITS.titleMax);
  const body = candidate.body;
  const bodyText = typeof body === 'string' ? body.trim() : '';
  if (!title || !bodyText) {
    rejected.push({ reason: 'empty', detail: 'missing title or body' });
    return null;
  }

  let tooLong = false;
  const trimmedBody =
    bodyText.length > LIMITS.bodyMax
      ? ((tooLong = true), bodyText.slice(0, LIMITS.bodyMax))
      : bodyText;
  const summary = clampText(candidate.summary, LIMITS.summaryMax) || firstLine(trimmedBody);
  if (summary.length > LIMITS.summaryMax) tooLong = true;

  // Evidence is the anti-hallucination gate: a note must rest on material the
  // window actually contains, and an id outside the window is treated as invention.
  const evidenceRaw = Array.isArray(candidate.evidence) ? candidate.evidence : [];
  const evidence = evidenceRaw
    .filter((id): id is string => typeof id === 'string')
    .map((id) => id.trim());
  const outside = evidence.filter((id) => !allowedEvidence.has(id));
  if (outside.length > 0) {
    rejected.push({
      reason: 'evidence_outside_window',
      detail: `${outside.length} id(s) not in window`,
    });
    return null;
  }
  if (evidence.length === 0) {
    rejected.push({ reason: 'no_evidence', detail: 'agent note without evidence' });
    return null;
  }

  const tags = normalizeTags(
    (Array.isArray(candidate.tags) ? candidate.tags : [])
      .filter((tag): tag is string => typeof tag === 'string')
      .slice(0, LIMITS.tagsMax),
  );

  const confidence =
    typeof candidate.confidence === 'number' && Number.isFinite(candidate.confidence)
      ? Math.max(0, Math.min(1, candidate.confidence))
      : null;

  if (tooLong) rejected.push({ reason: 'too_long', detail: 'trimmed to limits' });

  return {
    kind,
    title,
    summary,
    body: trimmedBody,
    fields: buildFields(kind, candidate.fields),
    tags,
    evidence: Array.from(new Set(evidence)),
    confidence,
  };
}

function firstLine(text: string): string {
  const line = text
    .split('\n')
    .map((item) => item.replace(/^[#>\-*\s]+/, '').trim())
    .find((item) => item.length > 0);
  return (line ?? '').slice(0, LIMITS.summaryMax);
}

/**
 * Parse + validate a raw model response.
 *
 * Exported separately from the model call so the rules are testable without a
 * provider, and so a repair retry can be judged by the same function.
 */
export function parseDistillResponse(
  raw: string,
  allowedEvidence: Iterable<string>,
): DistillOutcome {
  const rejected: DistillRejection[] = [];
  const json = extractJson(raw);
  if (!json) {
    return {
      notes: [],
      rejected: [{ reason: 'invalid_json', detail: 'no JSON object in response' }],
      rawChars: raw.length,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {
      notes: [],
      rejected: [{ reason: 'invalid_json', detail: 'JSON.parse failed' }],
      rawChars: raw.length,
    };
  }

  const list = (parsed as { notes?: unknown }).notes;
  if (!Array.isArray(list)) {
    return {
      notes: [],
      rejected: [{ reason: 'invalid_json', detail: 'missing notes array' }],
      rawChars: raw.length,
    };
  }

  const allowed = new Set(allowedEvidence);
  const notes = list
    .map((candidate) => validateNote(candidate, allowed, rejected))
    .filter((note): note is DistilledNote => note !== null);

  return { notes, rejected, rawChars: raw.length };
}

export interface DistillOptions {
  windowText: string;
  windowIds: string[];
  /** Upper bound from `notes.capture.maxNotesPerCapture`. */
  maxNotes?: number;
  modelConfig: AuxModelConfig;
  logger: Logger;
  /** Extra instruction appended to the user message (e.g. "the user asked for a pitfall"). */
  hint?: string;
}

/**
 * Call the model, validate, and retry once with a repair instruction on
 * unparseable output.
 *
 * Returns `notes: []` rather than throwing when the model reports nothing usable:
 * "this turn had nothing worth keeping" is a normal outcome, and the capture
 * pipeline records it as `empty` instead of failing the request.
 */
export async function distillNotes(options: DistillOptions): Promise<DistillOutcome> {
  const userPrompt = [
    '材料（每条前面括号里是它的 id）：',
    '',
    options.windowText,
    '',
    options.hint ? `附加要求：${options.hint}` : '',
    options.maxNotes ? `最多 ${options.maxNotes} 条。` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const first = await auxLLMCall(options.modelConfig, {
    systemPrompt: DISTILL_SYSTEM_PROMPT,
    userPrompt,
    temperature: 0.2,
    maxTokens: 2000,
    logger: options.logger,
  });

  const parsed = parseDistillResponse(first, options.windowIds);
  const unusable =
    parsed.notes.length === 0 && parsed.rejected.some((item) => item.reason === 'invalid_json');
  if (!unusable) return parsed;

  // One repair attempt: schema-shaped JSON is the one failure the model can
  // actually fix from feedback, and a second round trip is cheaper than losing
  // the capture.
  const repaired = await auxLLMCall(options.modelConfig, {
    systemPrompt: DISTILL_SYSTEM_PROMPT,
    userPrompt: `${userPrompt}\n\n上一次输出不是合法 JSON。只输出 JSON 对象，不要解释，不要代码块。`,
    temperature: 0.1,
    maxTokens: 2000,
    logger: options.logger,
  });
  return parseDistillResponse(repaired, options.windowIds);
}
