/**
 * Capture orchestration (plan §5): trigger → window → redact → distill → validate
 * → recap gate → persist draft.
 *
 * Dependency-injected rather than reaching for globals, because the interesting
 * parts (window resolution, redaction, the recap gate, dedupe) are unit-testable
 * and the model call is the one thing tests replace. `CaptureDeps.distill` is that
 * seam.
 *
 * `treatment` is a second axis, and `text` mode is where it earns its keep: text
 * dropped on the floating ball arrives `verbatim` (no model, no recap gate — the
 * user said "keep these words", which is the opposite of paraphrasing them) while
 * the same text with "let the agent tidy this up" asks for `distill`. Everything
 * else reads stored messages and is always distilled.
 *
 * `text` mode does not skip the review gate. Authorship decides *who* reviews, not
 * *whether* a note exists yet: a dropped selection has no title and no kind, so it
 * lands `draft` with `origin: 'user'` — the human supplied the words, nobody has
 * said they are a note.
 *
 * Ordering matters and is enforced here:
 *
 *   window  → an empty window means nothing to do, and no model call is made
 *   redact  → BEFORE the model sees it: a secret must never travel to a provider
 *   distill → one call, validated per note
 *   recap   → free filter for the "model summarised the conversation" failure
 *   persist → one transaction per note; a title this scope already holds is
 *             reported as a duplicate instead of a second row (dedupe, §5.5)
 *
 * `notes.worth` (the judge, §5.6) is not wired in M1: it is optional and
 * fail-open, and there is no verdict to record yet.
 */

import type { Logger } from 'pino';
import type Database from 'better-sqlite3';
import type { AuxModelConfig } from '../memory/aux-llm-client.js';
import type { Message } from '../memory/repositories/message-repository.js';
import { inferChannel } from '../memory/session-channel.js';
import { defaultScope } from './scope.js';
import { isRecap } from './recap.js';
import { redactSecrets, redactionMarker } from './redact.js';
import { distillNotes, type DistillOutcome } from './distill.js';
import { renderWindowPrompt, resolveWindow, type ResolvedWindow } from './window.js';
import type {
  CaptureRequest,
  CaptureResult,
  DuplicateNote,
  NotesRuntimeConfig,
} from './service-contract.js';
import type { NotesRepository } from './repository.js';
import type { Note } from './types.js';

export interface CaptureSession {
  id: string;
  channel: string | null;
  chatId: string | null;
  projectId: string | null;
  title: string | null;
}

export interface CaptureDeps {
  repository: NotesRepository;
  db: Database.Database;
  getConfig: () => NotesRuntimeConfig;
  /** By reference: the aux chain hot-reloads in place. */
  auxConfig: AuxModelConfig;
  logger: Logger;
  /** Test seam: replaces the model call. */
  distill?: (options: {
    windowText: string;
    windowIds: string[];
    maxNotes: number;
    bodyMaxChars: number;
    maxOutputTokens?: number;
    instruction?: string;
    hint?: string;
  }) => Promise<DistillOutcome>;
}

/** Both platform-agnostic and channel-specific "is this a shared room" checks. */
function isGroupChat(chatType: string | undefined, channel: string | null): boolean {
  if (chatType) return chatType === 'group' || chatType === 'supergroup';
  // Telegram supergroups have negative chat ids; QQ/WeChat put group markers in
  // the id. Feishu reports `p2p`/`group` explicitly, so it is never guessed here.
  return channel === 'telegram' || channel === 'qq' || channel === 'wechat' ? false : false;
}

export class CapturePipeline {
  private readonly deps: CaptureDeps;

  constructor(deps: CaptureDeps) {
    this.deps = deps;
  }

  /** Session context: channel, chat, project. Missing channel falls back to the id prefix. */
  loadSession(sessionId: string): CaptureSession | null {
    const row = this.deps.db
      .prepare('SELECT id, chat_id, channel, project_id, title FROM sessions WHERE id = ?')
      .get(sessionId) as
      | {
          id: string;
          chat_id: string | null;
          channel: string | null;
          project_id: string | null;
          title: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      channel: row.channel ?? inferChannel(row.id, row.chat_id),
      chatId: row.chat_id,
      projectId: row.project_id,
      title: row.title,
    };
  }

  /** Newest `limit` messages of a session, oldest-first. */
  private readMessages(sessionId: string, limit: number): Message[] {
    return this.deps.db
      .prepare(
        `SELECT * FROM messages WHERE session_id = ?
          ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(sessionId, limit) as Message[];
  }

  async capture(request: CaptureRequest): Promise<CaptureResult> {
    const config = this.deps.getConfig();
    const session = this.loadSession(request.sessionId);
    if (!session) {
      return { ok: false, code: 'no_session', message: `unknown session ${request.sessionId}` };
    }

    const treatment = this.treatmentOf(request);
    if (treatment === 'verbatim') return this.captureVerbatim(request, session);

    /**
     * An instruction is a request about the conversation, not about the last
     * exchange: "把刚才分享的命令存下来" and "把今天的聊天整理成笔记" are both
     * wider than one turn. Widening only when the instruction says so keeps the
     * default capture cheap — one exchange is what the button promises.
     */
    const instructed = (request.instruction ?? '').trim().length > 0;
    const mode = instructed && request.mode === 'turn' ? 'recent' : request.mode;
    const turns =
      request.turns ?? (instructed ? Math.max(config.windowTurns, 5) : config.windowTurns);

    // How much history to load depends on the mode: `recent` needs turns × 2 plus
    // tool rows, `turn` needs the tail, `selection` needs ids only.
    const historyLimit = mode === 'recent' ? Math.min(turns * 8, 200) : 60;
    const history = this.readMessages(session.id, historyLimit);

    const window: ResolvedWindow = resolveWindow(history, {
      sessionId: session.id,
      mode,
      turns,
      messageIds: request.messageIds,
      text: request.text,
      includeTools: config.includeTools,
      tokenBudget: config.tokenBudget,
    });

    const captureId = this.deps.repository.createCaptureRun({
      sessionId: session.id,
      scope: request.scope ?? 'user',
      mode,
      messageIds: window.messageIds,
      tokenEst: window.tokenEst,
      status: 'ok',
    });

    if (window.error || window.messages.length === 0) {
      this.deps.repository.updateCaptureRun(captureId, {
        status: 'empty',
        error: window.error ?? 'no_messages',
      });
      return {
        ok: false,
        code: 'empty_window',
        captureId,
        message: window.error ?? 'no messages in window',
      };
    }

    const rawWindowText = renderWindowPrompt(window.messages);
    const redacted = config.redact
      ? redactSecrets(rawWindowText)
      : { text: rawWindowText, count: 0 };

    /**
     * Citable evidence is every message *in the window*, which for `text` mode is
     * the synthetic `selection` row. `window.messageIds` stays the real-message
     * ids used for the capture ledger, so a distilled selection can cite its own
     * material without inventing a stored message (see the sources mapping below).
     */
    const citableIds = window.messages.map((message) => message.id);
    const instruction = (request.instruction ?? '').trim() || undefined;
    const kindHint = request.kind
      ? `If it really is that category, use kind="${request.kind}".`
      : undefined;

    let outcome: DistillOutcome;
    try {
      outcome = await this.runDistill({
        windowText: redacted.text,
        windowIds: citableIds,
        maxNotes: config.maxNotesPerCapture,
        bodyMaxChars: config.bodyMaxChars,
        maxOutputTokens: config.maxOutputTokens,
        instruction,
        hint: kindHint,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.repository.updateCaptureRun(captureId, {
        status: 'failed',
        error: message.slice(0, 500),
      });
      this.deps.logger.warn({ err }, 'Note capture failed: model call errored');
      return { ok: false, code: 'model_failed', captureId, message };
    }

    if (outcome.notes.length === 0) {
      const status = outcome.rejected.some((item) => item.reason === 'invalid_json')
        ? 'invalid'
        : 'empty';
      this.deps.repository.updateCaptureRun(captureId, {
        status,
        error: outcome.rejected
          .map((item) => `${item.reason}:${item.detail}`)
          .join('; ')
          .slice(0, 500),
      });
      return {
        ok: false,
        code: status === 'invalid' ? 'invalid' : 'no_notes',
        captureId,
        message: 'nothing worth keeping in this window',
      };
    }

    if (outcome.kindFallbacks.length > 0) {
      // Kept as `other` (a label never rejects a note) but counted: a run of these
      // means the prompt's vocabulary is not the one the model reaches for, and the
      // side effect is invisible — `other` also has no slot whitelist.
      this.deps.logger.warn(
        {
          captureId,
          labels: outcome.kindFallbacks.map((item) => item.label),
          notes: outcome.kindFallbacks.length,
        },
        'Note distiller used a kind outside NOTE_KINDS; kept as other',
      );
    }

    const finalScope = this.resolveScope(request, session);

    const drafts: Note[] = [];
    const duplicates: DuplicateNote[] = [];
    let droppedRecaps = 0;
    let overCap = 0;
    /**
     * Iterate *every* candidate and apply the cap at creation time, not by slicing the
     * response first.
     *
     * The old order (`slice(0, max)` then filters) spent a slot on a candidate the local
     * gates were about to drop: two duplicates in front meant a unique third note was
     * never created, and nothing said so. The gates here are cheap and local, so they run
     * on the whole response and the cap decides only what gets a row.
     */
    for (const candidate of outcome.notes) {
      const verdict = isRecap({
        body: candidate.body,
        tags: candidate.tags,
        windowText: redacted.text,
      });
      /**
       * The gate exists to catch the model summarising the conversation when
       * nobody asked for a summary — "把今天的聊天整理成笔记" *is* that request, so
       * an explicit instruction downgrades the gate to a logged signal. The draft
       * still needs approval, which is the human check the gate was standing in for.
       */
      if (verdict.recap) {
        this.deps.logger.debug(
          { score: verdict.score, title: candidate.title, instructed },
          verdict.recap && !instructed
            ? 'Note draft dropped as a recap of the window'
            : 'Note draft restates the window, kept because the user asked for it',
        );
        if (!instructed) {
          droppedRecaps += 1;
          continue;
        }
      }

      // Dedupe, and it is not cosmetic: the unique index only covers `active`, so
      // two drafts could hold one title and the second could then never be approved
      // (the index threw). One title, one row, per scope — the reviewer is told
      // which row already has it instead of being handed a near-copy.
      const owner = this.deps.repository.findByTitle(
        candidate.title,
        finalScope.scope,
        finalScope.scopeKey,
      );
      if (owner) {
        duplicates.push({ title: candidate.title, existingId: owner.id, status: owner.status });
        continue;
      }

      if (drafts.length >= config.maxNotesPerCapture) {
        // Past the cap. Counted rather than silently dropped: a config whose cap is
        // smaller than what the material holds is a decision the operator made, and the
        // log is where they find out it cost them a note.
        overCap += 1;
        continue;
      }

      const created = this.deps.repository.create({
        kind: candidate.kind,
        title: candidate.title,
        summary: candidate.summary,
        body: candidate.body,
        fields: candidate.fields,
        tags: candidate.tags,
        // The hard gate of the layer: model-distilled content is never active.
        status: 'draft',
        origin: 'agent',
        scope: finalScope.scope,
        scopeKey: finalScope.scopeKey,
        sessionId: session.id,
        channel:
          session.channel && session.channel !== 'unknown' ? asChannel(session.channel) : null,
        confidence: candidate.confidence,
        captureId,
        sources: this.sourcesFor(request, candidate.evidence, session),
        actor: request.actor ?? 'agent',
      });

      if (!created.ok) {
        // Racing captures aside, `findByTitle` above should have caught this; if the
        // index still refuses, the honest answer is the same duplicate, not a
        // retitled copy nobody asked for.
        duplicates.push({
          title: candidate.title,
          existingId: created.existingId,
          status: 'active',
        });
        continue;
      }
      drafts.push(created.note);
    }

    this.deps.repository.updateCaptureRun(captureId, {
      status: drafts.length > 0 ? 'ok' : 'empty',
      noteCount: drafts.length,
      error: redactionMarker(redacted.count),
    });

    if (overCap > 0) {
      this.deps.logger.warn(
        { captureId, overCap, cap: config.maxNotesPerCapture, produced: outcome.notes.length },
        'Note capture produced more drafts than notes.capture.maxNotesPerCapture allows; the excess was not stored',
      );
    }

    if (drafts.length === 0) {
      // "Already have it" and "nothing worth keeping" are different answers, and the
      // card says so: the first one has somewhere to go, the second does not.
      if (duplicates.length > 0) {
        return {
          ok: false,
          code: 'duplicate',
          captureId,
          duplicates,
          message: 'that note already exists',
        };
      }
      return {
        ok: false,
        code: 'no_notes',
        captureId,
        message:
          droppedRecaps > 0 ? 'every candidate restated the conversation' : 'nothing worth keeping',
      };
    }

    return {
      ok: true,
      captureId,
      notes: drafts,
      duplicates,
      redacted: redacted.count,
      droppedRecaps,
    };
  }

  /**
   * The scope rule, in one place: an explicit request wins, `session` can only
   * arrive explicitly and is never inferred (§5.7), otherwise the session's channel
   * / project decides.
   */
  private resolveScope(
    request: CaptureRequest,
    session: CaptureSession,
  ): { scope: Note['scope']; scopeKey: string } {
    if (request.scope === 'session') {
      return { scope: 'session', scopeKey: request.scopeKey ?? session.id };
    }
    if (request.scope) return { scope: request.scope, scopeKey: request.scopeKey ?? '' };
    return defaultScope({
      channel: session.channel,
      isGroupChat: isGroupChat(request.chatType, session.channel),
      chatId: session.chatId,
      projectId: session.projectId,
    });
  }

  /**
   * `distill` | `verbatim`, defaulted by mode.
   *
   * The default is the interesting part: `text` is the only mode whose material
   * the user wrote, so "just keep it" is the safe assumption and distilling is the
   * thing you have to ask for. A window of stored messages has no such reading —
   * nobody wants a note that is a copy of the transcript.
   */
  private treatmentOf(request: CaptureRequest): 'distill' | 'verbatim' {
    if (request.treatment) {
      // `verbatim` only means something for text; asking for it over a stored
      // window would store a transcript, which is the failure the layer exists to
      // prevent. Coerced rather than rejected: the caller is our own UI.
      if (request.treatment === 'verbatim' && request.mode === 'text') return 'verbatim';
      return 'distill';
    }
    return request.mode === 'text' ? 'verbatim' : 'distill';
  }

  /**
   * Where a distilled note's provenance points.
   *
   * A note distilled from dropped text cites the synthetic `selection` row, which
   * is not a stored message — recording it as `{kind:'message'}` would claim a
   * quote nobody can open. The session it was captured in is the honest answer,
   * and it is exactly what a verbatim capture records too.
   */
  private sourcesFor(
    request: CaptureRequest,
    evidence: string[],
    session: CaptureSession,
  ): Array<{ kind: 'message' | 'session'; id: string }> {
    if (request.mode === 'text') return [{ kind: 'session', id: session.id }];
    return evidence.map((id) => ({ kind: 'message' as const, id }));
  }

  /**
   * `verbatim`: store the text exactly as it arrived.
   *
   * No model call and no recap gate — there is nothing to judge, the text is what
   * the user chose. It still lands `draft`, because authorship decides *who*
   * reviews, not whether a pile of words is already a note: a dropped selection
   * has no title and no kind, so `origin: 'user'` records who supplied it and
   * `draft` records that nobody has said it is worth keeping yet. The redactor
   * stays out of the way too, for the same reason it always did here — hiding a key
   * the user deliberately pasted is editing their note without saying so.
   */
  private captureVerbatim(request: CaptureRequest, session: CaptureSession): CaptureResult {
    const text = (request.text ?? '').trim();
    const captureId = this.deps.repository.createCaptureRun({
      sessionId: session.id,
      scope: request.scope ?? 'user',
      mode: 'text',
      messageIds: [],
      tokenEst: estimateNoteTokens(text),
      status: 'ok',
    });

    if (!text) {
      this.deps.repository.updateCaptureRun(captureId, { status: 'empty', error: 'empty_text' });
      return {
        ok: false,
        code: 'empty_window',
        captureId,
        message: 'nothing to keep: the text is empty',
      };
    }

    const scope = this.resolveScope(request, session);
    const body = text.slice(0, TEXT_NOTE_MAX_CHARS);
    const title = titleFromText(body);
    // The same dedupe as the distilled path. Dropping the same selection twice is the
    // cheapest way to make a duplicate, so this is the path that needed it most.
    const owner = this.deps.repository.findByTitle(title, scope.scope, scope.scopeKey);
    if (owner) {
      this.deps.repository.updateCaptureRun(captureId, { status: 'empty', error: 'duplicate' });
      return {
        ok: false,
        code: 'duplicate',
        captureId,
        duplicates: [{ title, existingId: owner.id, status: owner.status }],
        message: 'that note already exists',
      };
    }
    const created = this.deps.repository.create({
      kind: request.kind ?? 'other',
      title,
      summary: '',
      body,
      fields: [],
      tags: [],
      // Raw material, not a note yet: see the method comment.
      status: 'draft',
      origin: 'user',
      scope: scope.scope,
      scopeKey: scope.scopeKey,
      sessionId: session.id,
      channel: session.channel && session.channel !== 'unknown' ? asChannel(session.channel) : null,
      captureId,
      // Provenance is the conversation it was dropped in, not a message: the text
      // may be a tidy-up of what the user meant, so citing a message id would claim
      // a quote that is not there.
      sources: [{ kind: 'session', id: session.id }],
      actor: request.actor ?? 'user',
    });

    if (!created.ok) {
      this.deps.repository.updateCaptureRun(captureId, {
        status: 'failed',
        error: 'title_conflict',
      });
      return {
        ok: false,
        code: 'invalid',
        captureId,
        message: 'a note titled "' + title + '" already exists',
      };
    }

    this.deps.repository.updateCaptureRun(captureId, { status: 'ok', noteCount: 1 });
    return {
      ok: true,
      captureId,
      notes: [created.note],
      duplicates: [],
      redacted: 0,
      droppedRecaps: 0,
    };
  }

  private runDistill(input: {
    windowText: string;
    windowIds: string[];
    maxNotes: number;
    bodyMaxChars: number;
    maxOutputTokens?: number;
    instruction?: string;
    hint?: string;
  }): Promise<DistillOutcome> {
    if (this.deps.distill) return this.deps.distill(input);
    return distillNotes({
      ...input,
      modelConfig: this.deps.auxConfig,
      logger: this.deps.logger,
    });
  }
}

/** A sentence someone typed is a note, not an essay; pasted logs get cut, not refused. */
const TEXT_NOTE_MAX_CHARS = 4000;

/** Rough token estimate for the diagnostic log — CJK per character, latin per 4. */
function estimateNoteTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g) ?? []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk / 2 + rest / 4);
}

/** The title is the first line that says something; a single-line note uses itself. */
function titleFromText(text: string): string {
  const line = text
    .split('\n')
    .map((item) => item.replace(/^[#>*\-\s]+/, '').trim())
    .find((item) => item.length > 0);
  const title = (line ?? text).slice(0, 60).trim();
  return title || '随手记';
}

/** Session channels we recognise; `unknown` is dropped rather than stored. */
function asChannel(channel: string): Note['channel'] {
  return ['feishu', 'telegram', 'wechat', 'qq', 'webui', 'cron'].includes(channel)
    ? (channel as Note['channel'])
    : null;
}
