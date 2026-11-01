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
import {
  BODY_MAX_DEFAULT,
  MAX_NOTES_DEFAULT,
  WINDOW_TURNS_MAX,
  deriveMaxOutputTokens,
} from './output-budget.js';
import { NOTE_FIELDS, isNoteKind, type NoteField, type NoteKind } from './types.js';

/** Caps from the plan §5.3 validation table. `bodyMax` is configurable, see output-budget.ts. */
const LIMITS = {
  titleMax: 60,
  summaryMax: 120,
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
    | 'evidence_outside_scope'
    | 'no_evidence';
  /** Short diagnostic, never the note body (it may contain a secret). */
  detail: string;
}

/**
 * What the model reported the brief asked for, in numbers.
 *
 * The model reads the language ("只整理最近 3 轮", "last 3 exchanges", "前面那两段别记了"),
 * the code enforces the result: evidence drawn from outside this scope is a rejection,
 * not a style note. Parsing the same sentence with a regex only ever matched the
 * phrasings the regex author imagined, and silently fell back to "read everything" for
 * the rest — correctly enough, but unverifiable.
 */
export interface ReportedScope {
  turns?: number;
  chars?: number;
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
  /** What the brief said about how much to cover, when the model reported it. */
  scope?: ReportedScope;
}

/**
 * The system prompt. Kept in one function so the validation rules and the
 * instructions are read side by side during review, and so the two numbers that
 * appear inside it (body cap, deliberate note limit) come from config instead of
 * being copied into prose that then drifts from the validator.
 */
export function buildDistillSystemPrompt(options: {
  bodyMaxChars?: number;
  /** Only mentioned when it narrows the defaults; see the call site. */
  maxNotes?: number;
}): string {
  const bodyMax = options.bodyMaxChars ?? BODY_MAX_DEFAULT;
  const noteCapLine =
    options.maxNotes && options.maxNotes !== MAX_NOTES_DEFAULT
      ? `\nThe operator allows at most ${options.maxNotes} note(s) per capture; stay within that.`
      : '';

  return `You are the note distiller. The user has just finished a piece of work and wants whatever will be reusable later extracted from it.

Produce only the kind of knowledge that will be needed again:
- command   one concrete command, flag set or one-liner, copy-pasteable as-is
- workflow  an ordered set of steps, including the checkpoints that tell you it worked
- pitfall   what went wrong: symptom -> root cause -> fix -> how to avoid it
- insight   a principle worth knowing: one assertion plus why it holds
- opinion   a judgement worth keeping, attributed to whoever said it
- reference how a model, API or config is set up, what its parameters mean, its limits
- decision  the decision, its background, and the options that were dropped

Hard rules:
1. Default to **one** note. A human reviews every draft, so every extra note costs them a read and a
   decision: when you are unsure whether something deserves its own note, keep it inside the one you
   are writing.
2. Split into several notes only when the material holds different **subjects** - things that would get
   different titles and each stand on their own. Never split one subject into background / steps /
   pitfalls / conclusion: that is one note with sections.${noteCapLine}
3. The title says what is inside, precisely enough that a reviewer can decide whether to open it. Name
   the content, not the category: "Project notes", "Summary", "Misc" are wrong; when a note holds a
   repository URL and the design philosophy behind it, "repo URL and design philosophy" is right.
4. Do not retell the conversation. Never write "the user asked X, then the assistant did Y".
5. Every note must cite evidence: the id shown in square brackets before each entry, and only ids that appear there.
6. If nothing is worth keeping, return {"notes": []}. Zero notes is allowed; padding is not.
7. Keep body under ${bodyMax} characters, in markdown; put commands in \`\`\` code blocks. Use \`## \`
   sections when the note covers more than one aspect of its subject.
8. When authoritative detail is missing, leave it out. Do not guess a flag, a version or a path.
9. Never include secrets, cookies or personal data. Anything that looks like a credential stays out of the body.
10. The kinds and slots above are hints, not a form. If a slot has nothing to say, write the body alone.
    A note that fits no template but is worth keeping gets kind="other" - never drop content to fit a template.
11. Record conclusions, not the process. Do not add a conclusion the material does not support.
12. When a "brief from the user" is present it outranks the rules above: it may relax rule 11 (for example
    "turn today's chat into notes") or narrow the scope (for example "only that one command").
    It never licenses inventing something the material does not contain.
12b. If the brief states how much to cover - a number of turns or exchanges, or a number of characters -
    report that number in "scope", in whatever words the brief used, and then take evidence ONLY from
    that part of the material, counting back from the end. "scope" is a report of the brief, never your
    own preference: omit it when the brief says nothing about how much to cover. Example: a brief saying
    "only the last 3 exchanges" gives "scope":{"turns":3} and no evidence from earlier entries.
13. Write title, summary and body in the language the material is written in - this prompt being English
    is not an instruction to translate. Commands, paths, flags and identifiers stay exactly as written.
14. Tag the subject, not the aspect: one fixed kebab-case tag per project, tool or person (the same
    spelling every time), and let the title carry the aspect. This is what keeps notes about one subject
    linked to each other later, and it only works if the tag is spelled the same way twice.

Output strict JSON:
{"scope":{"turns":3},"notes":[{"kind":"command","title":"<=60 chars","summary":"<=120 chars, one line","body":"markdown","fields":{"command":"...","when":"..."},"tags":["kebab-case"],"evidence":["<id from the material>"],"confidence":0.8}]}
The "scope" key is optional and may instead be {"chars":2000}; omit it entirely when the brief states no amount.`;
}

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
  bodyMaxChars: number,
  /** Present only when the model reported a scope: the ids that scope permits. */
  scopedEvidence?: Set<string>,
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
    bodyText.length > bodyMaxChars ? ((tooLong = true), bodyText.slice(0, bodyMaxChars)) : bodyText;
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

  /**
   * The brief said "only the last N turns" and this note cites an earlier one. The
   * note is not wrong, it is out of scope — and keeping it would silently widen a
   * limit the user set. Rejection is per note, so the in-scope notes survive.
   */
  if (scopedEvidence) {
    const beyond = evidence.filter((id) => !scopedEvidence.has(id));
    if (beyond.length > 0) {
      rejected.push({
        reason: 'evidence_outside_scope',
        detail: `${beyond.length} id(s) older than the scope the brief stated`,
      });
      return null;
    }
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
 * Read the model's `scope` report.
 *
 * Deliberately forgiving about shapes (`{turns: 3}`, `{turns: "3"}`, `{chars: 2000}`)
 * and strict about values: a number outside what a window could mean is treated as
 * "no scope at all" rather than being clamped into one, because a clamped scope would
 * reject good notes by accident.
 */
function readScope(parsed: unknown): ReportedScope | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const raw = (parsed as { scope?: unknown }).scope;
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const number = (value: unknown): number | undefined => {
    const numeric = typeof value === 'string' ? Number(value) : value;
    return typeof numeric === 'number' && Number.isFinite(numeric)
      ? Math.floor(numeric)
      : undefined;
  };
  const turns = number(record.turns);
  const chars = number(record.chars);
  const scope: ReportedScope = {};
  if (turns !== undefined && turns >= 1 && turns <= WINDOW_TURNS_MAX) scope.turns = turns;
  if (chars !== undefined && chars >= 1) scope.chars = chars;
  return scope.turns === undefined && scope.chars === undefined ? undefined : scope;
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
  bodyMaxChars: number = BODY_MAX_DEFAULT,
  /**
   * Turns a reported scope into the ids it permits. The window owns the definition of
   * a turn, so the caller supplies it; without this the scope is reported but not
   * enforced, which is what a regex on the instruction used to do (badly).
   */
  scopeIds?: (scope: ReportedScope) => Set<string>,
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

  const scope = readScope(parsed);
  const allowed = new Set(allowedEvidence);
  const scoped = scope && scopeIds ? scopeIds(scope) : null;
  const notes = list
    .map((candidate) =>
      validateNote(
        candidate,
        allowed,
        rejected,
        kindFallbacks,
        bodyMaxChars,
        // A scope can only ever narrow: an id outside the window is already an
        // invention, and an id inside the scope is not automatically in the window.
        scoped && scoped.size > 0 ? scoped : undefined,
      ),
    )
    .filter((note): note is DistilledNote => note !== null);

  return { notes, rejected, kindFallbacks, rawChars: raw.length, scope };
}

export interface DistillOptions {
  windowText: string;
  windowIds: string[];
  /** Upper bound from `notes.capture.maxNotesPerCapture`. */
  maxNotes?: number;
  /** Body cap from `notes.capture.bodyMaxChars`; also what the prompt states. */
  bodyMaxChars?: number;
  /**
   * Output budget. Omitted = derived from `bodyMaxChars` x `maxNotes`
   * (`deriveMaxOutputTokens`). Exposed because a model that pads fields and tags
   * may need headroom, and because config-level overrides are validated at boot.
   */
  maxOutputTokens?: number;
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
  /**
   * Sampling temperature for the first attempt (`notes.capture.temperature`). The
   * repair retry halves it: a second attempt at the same temperature tends to
   * reproduce the same malformed shape.
   */
  temperature?: number;
  /**
   * Turns a model-reported scope into the ids it permits (see `parseDistillResponse`).
   * Absent = the scope is reported but not enforced, which is only right when there is
   * no window to check against.
   */
  scopeIds?: (scope: ReportedScope) => Set<string>;
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
  const bodyMaxChars = options.bodyMaxChars ?? BODY_MAX_DEFAULT;
  const systemPrompt = buildDistillSystemPrompt({
    bodyMaxChars,
    maxNotes: options.maxNotes,
  });
  /**
   * The body cap is stated in the prompt; the token budget is derived from it so the
   * two cannot drift. Stating the note cap unconditionally ("at most 3 note(s)") read
   * as a target: a run holding one note started answering with three, which is what
   * a number in front of a model that had no opinion yet does.
   */
  const maxTokens =
    options.maxOutputTokens ??
    deriveMaxOutputTokens(bodyMaxChars, options.maxNotes ?? MAX_NOTES_DEFAULT);

  const userPrompt = [
    options.instruction
      ? `Brief from the user for this capture (it outranks the defaults above; where they conflict, follow it):\n${options.instruction}`
      : '',
    'Material (each entry starts with its id in square brackets):',
    '',
    options.windowText,
    '',
    options.hint ? `Extra requirement: ${options.hint}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const temperature = options.temperature ?? 0.2;

  const first = await auxLLMCall(options.modelConfig, {
    systemPrompt,
    userPrompt,
    temperature,
    maxTokens,
    logger: options.logger,
  });

  const parsed = parseDistillResponse(first, options.windowIds, bodyMaxChars, options.scopeIds);
  const unusable =
    parsed.notes.length === 0 && parsed.rejected.some((item) => item.reason === 'invalid_json');
  if (!unusable) return parsed;

  // One repair attempt: schema-shaped JSON is the one failure the model can
  // actually fix from feedback, and a second round trip is cheaper than losing
  // the capture.
  const repaired = await auxLLMCall(options.modelConfig, {
    systemPrompt,
    userPrompt: `${userPrompt}\n\nThe previous output was not valid JSON. Output the JSON object only - no explanation, no code fence.`,
    temperature: temperature / 2,
    maxTokens,
    logger: options.logger,
  });
  return parseDistillResponse(repaired, options.windowIds, bodyMaxChars, options.scopeIds);
}
