/**
 * Distillation: turn a conversation window into candidate notes (plan §5.3).
 *
 * One model call, low temperature, aux model by default (`notes.capture.modelRef`
 * overrides). Extraction is throughput work and wants a fast non-reasoning model —
 * the same argument memory summarization already carries.
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
  /**
   * Labels the model used that are not in `NOTE_KINDS`, with the note they landed on.
   *
   * Such a note is kept as `other` — a wrong label is not a reason to lose a good
   * note — but the label is worth reporting: a run of them says the prompt's
   * vocabulary is not the vocabulary this model reaches for, which is a prompt bug
   * rather than a model bug.
   */
  kindFallbacks: Array<{ label: string; title: string }>;
  /** Raw model output length, for the diagnostic log. */
  rawChars: number;
}

/**
 * The system prompt. Kept in one template literal so the validation rules and
 * the instructions are read side by side during review.
 */
export const DISTILL_SYSTEM_PROMPT = `You are the note distiller. The user has just finished a piece of work and wants whatever will be reusable later extracted from it.

Produce only the kind of knowledge that will be needed again:
- command   one concrete command, flag set or one-liner, copy-pasteable as-is
- workflow  an ordered set of steps, including the checkpoints that tell you it worked
- pitfall   what went wrong: symptom -> root cause -> fix -> how to avoid it
- insight   a principle worth knowing: one assertion plus why it holds
- opinion   a judgement worth keeping, attributed to whoever said it
- reference how a model, API or config is set up, what its parameters mean, its limits
- decision  the decision, its background, and the options that were dropped

Hard rules:
1. Do not retell the conversation. Never write "the user asked X, then the assistant did Y".
2. Every note must cite evidence: the id shown in square brackets before each entry, and only ids that appear there.
3. If nothing is worth keeping, return {"notes": []}. Zero notes is allowed; padding is not.
4. Keep body under 600 characters, in markdown; put commands in \`\`\` code blocks.
5. When authoritative detail is missing, leave it out. Do not guess a flag, a version or a path.
6. Never include secrets, cookies or personal data. Anything that looks like a credential stays out of the body.
7. The kinds and slots above are hints, not a form. If a slot has nothing to say, write the body alone.
   A note that fits no template but is worth keeping gets kind="other" - never drop content to fit a template.
8. Record conclusions, not the process. Do not add a conclusion the material does not support.
9. When a "brief from the user" is present it outranks the rules above: it may relax rule 8 (for example
   "turn today's chat into notes") or narrow the scope (for example "only that one command").
   It never licenses inventing something the material does not contain.
10. Write title, summary and body in the language the material is written in - this prompt being English
   is not an instruction to translate. Commands, paths, flags and identifiers stay exactly as written.

Output strict JSON:
{"notes":[{"kind":"command","title":"<=60 chars","summary":"<=120 chars, one line","body":"markdown","fields":{"command":"...","when":"..."},"tags":["kebab-case"],"evidence":["<id from the material>"],"confidence":0.8}]}`;

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
  kindFallbacks: Array<{ label: string; title: string }>,
): DistilledNote | null {
  if (!raw || typeof raw !== 'object') {
    rejected.push({ reason: 'not_object', detail: 'candidate is not an object' });
    return null;
  }
  const candidate = raw as Record<string, unknown>;

  const title = clampText(candidate.title, LIMITS.titleMax);

  // A label outside the closed set becomes `other`, never a rejection. The plan's
  // invariant is that `kind` is a suggestion and cannot refuse a note, and a model
  // given Chinese material may answer `"命令"` — discarding the note for that would
  // lose content over a label. Reported instead, so a prompt whose vocabulary the
  // model will not use is visible rather than silently degrading every note to
  // `other` (which also drops the per-kind slot whitelist, see `buildFields`).
  const kind: NoteKind = isNoteKind(candidate.kind) ? candidate.kind : 'other';
  if (kind === 'other' && candidate.kind !== 'other') {
    kindFallbacks.push({ label: String(candidate.kind ?? 'missing').slice(0, 40), title });
  }

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
  const kindFallbacks: Array<{ label: string; title: string }> = [];
  const json = extractJson(raw);
  if (!json) {
    return {
      notes: [],
      rejected: [{ reason: 'invalid_json', detail: 'no JSON object in response' }],
      kindFallbacks,
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
      kindFallbacks,
      rawChars: raw.length,
    };
  }

  const list = (parsed as { notes?: unknown }).notes;
  if (!Array.isArray(list)) {
    return {
      notes: [],
      rejected: [{ reason: 'invalid_json', detail: 'missing notes array' }],
      kindFallbacks,
      rawChars: raw.length,
    };
  }

  const allowed = new Set(allowedEvidence);
  const notes = list
    .map((candidate) => validateNote(candidate, allowed, rejected, kindFallbacks))
    .filter((note): note is DistilledNote => note !== null);

  return { notes, rejected, kindFallbacks, rawChars: raw.length };
}

export interface DistillOptions {
  windowText: string;
  windowIds: string[];
  /** Upper bound from `notes.capture.maxNotesPerCapture`. */
  maxNotes?: number;
  modelConfig: AuxModelConfig;
  logger: Logger;
  /**
   * The user's own request for this capture ("keep the command you shared",
   * "turn today's chat into notes").
   *
   * It is not a hint, it is a requirement: the default rules below describe what
   * is *usually* worth keeping, and a person who says what they want outranks that
   * guess. Sent as its own block so the model can tell the two apart.
   */
  instruction?: string;
  /** Narrow hint from the caller (e.g. "the user asked for a pitfall"). */
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
    options.instruction
      ? `Brief from the user for this capture (it outranks the defaults above; where they conflict, follow it):\n${options.instruction}`
      : '',
    'Material (each entry starts with its id in square brackets):',
    '',
    options.windowText,
    '',
    options.hint ? `Extra requirement: ${options.hint}` : '',
    options.maxNotes ? `At most ${options.maxNotes} notes.` : '',
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
    userPrompt: `${userPrompt}\n\nThe previous output was not valid JSON. Output the JSON object only - no explanation, no code fence.`,
    temperature: 0.1,
    maxTokens: 2000,
    logger: options.logger,
  });
  return parseDistillResponse(repaired, options.windowIds);
}
