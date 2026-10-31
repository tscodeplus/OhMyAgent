/**
 * Capture orchestration (plan §5): trigger → window → redact → distill → validate
 * → recap gate → persist draft.
 *
 * Dependency-injected rather than reaching for globals, because the interesting
 * parts (window resolution, redaction, the recap gate, dedupe) are unit-testable
 * and the model call is the one thing tests replace. `CaptureDeps.distill` is that
 * seam.
 *
 * `text` mode branches off early and is the exception: the user's own sentence is
 * stored verbatim, `active` on arrival, and the model never sees it. Authorship
 * decides review (§4.2-2) — distilling "remember this sentence" would turn a
 * command into a suggestion, and a sentence the user typed is not a candidate.
 *
 * Ordering matters and is enforced here:
 *
 *   window  → an empty window means nothing to do, and no model call is made
 *   redact  → BEFORE the model sees it: a secret must never travel to a provider
 *   distill → one call, validated per note
 *   recap   → free filter for the "model summarised the conversation" failure
 *   persist → one transaction per note; a duplicate title becomes an update hint
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
import type { CaptureRequest, CaptureResult, NotesRuntimeConfig } from './service-contract.js';
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

    if (request.mode === 'text') return this.captureVerbatim(request, session);

    // How much history to load depends on the mode: `recent` needs turns × 2 plus
    // tool rows, `turn` needs the tail, `selection` needs ids only.
    const historyLimit = request.mode === 'recent' ? Math.min((request.turns ?? 5) * 8, 200) : 60;
    const history = this.readMessages(session.id, historyLimit);

    const window: ResolvedWindow = resolveWindow(history, {
      sessionId: session.id,
      mode: request.mode,
      turns: request.turns ?? config.windowTurns,
      messageIds: request.messageIds,
      text: request.text,
      includeTools: config.includeTools,
      tokenBudget: config.tokenBudget,
    });

    const captureId = this.deps.repository.createCaptureRun({
      sessionId: session.id,
      scope: request.scope ?? 'user',
      mode: request.mode,
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

    const hint = request.kind ? `如果确实是这个类别，用 kind="${request.kind}"。` : undefined;
    let outcome: DistillOutcome;
    try {
      outcome = await this.runDistill({
        windowText: redacted.text,
        windowIds: window.messageIds,
        maxNotes: config.maxNotesPerCapture,
        hint,
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

    const finalScope = this.resolveScope(request, session);

    const drafts: Note[] = [];
    let droppedRecaps = 0;
    for (const candidate of outcome.notes.slice(0, config.maxNotesPerCapture)) {
      const verdict = isRecap({
        body: candidate.body,
        tags: candidate.tags,
        windowText: redacted.text,
      });
      if (verdict.recap) {
        droppedRecaps += 1;
        this.deps.logger.debug(
          { score: verdict.score, title: candidate.title },
          'Note draft dropped as a recap of the window',
        );
        continue;
      }

      const created = this.deps.repository.create({
        kind: candidate.kind,
        title: candidate.title,
        summary: candidate.summary,
        body: candidate.body,
        fields: candidate.fields,
        tags: candidate.tags,
        // The hard gate of the layer: agent-distilled content is never active.
        status: 'draft',
        origin: 'agent',
        scope: finalScope.scope,
        scopeKey: finalScope.scopeKey,
        sessionId: session.id,
        channel:
          session.channel && session.channel !== 'unknown' ? asChannel(session.channel) : null,
        confidence: candidate.confidence,
        captureId,
        sources: candidate.evidence.map((id) => ({ kind: 'message' as const, id })),
        actor: request.actor ?? 'agent',
      });

      if (!created.ok) {
        // Same subject already active in this scope: not a new note, an update
        // suggestion. M1 records it as a draft anyway (the reviewer decides),
        // which is why the conflict is not an error here.
        this.deps.logger.debug(
          { existingId: created.existingId, title: candidate.title },
          'Note title already active in scope — draft still recorded',
        );
        const fallback = this.deps.repository.create({
          kind: candidate.kind,
          title: `${candidate.title}（补充）`.slice(0, 60),
          summary: candidate.summary,
          body: candidate.body,
          fields: candidate.fields,
          tags: candidate.tags,
          status: 'draft',
          origin: 'agent',
          scope: finalScope.scope,
          scopeKey: finalScope.scopeKey,
          sessionId: session.id,
          channel:
            session.channel && session.channel !== 'unknown' ? asChannel(session.channel) : null,
          confidence: candidate.confidence,
          captureId,
          sources: candidate.evidence.map((id) => ({ kind: 'message' as const, id })),
          actor: request.actor ?? 'agent',
        });
        if (fallback.ok) drafts.push(fallback.note);
        continue;
      }
      drafts.push(created.note);
    }

    this.deps.repository.updateCaptureRun(captureId, {
      status: 'ok',
      noteCount: drafts.length,
      error: redactionMarker(redacted.count),
    });

    if (drafts.length === 0) {
      return {
        ok: false,
        code: 'no_notes',
        captureId,
        message:
          droppedRecaps > 0 ? 'every candidate restated the conversation' : 'nothing worth keeping',
      };
    }

    return { ok: true, captureId, notes: drafts, redacted: redacted.count, droppedRecaps };
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
   * `text` mode: store the user's sentence as-is.
   *
   * No model call, no draft, no recap gate — all three exist to judge content the
   * agent produced. The title falls back to the sentence's first line, because the
   * caller is a dialog with one input, not a form with two.
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
    // The user wrote it, so the redactor stays out of the way: hiding a key they
    // deliberately pasted would be editing their note without saying so.
    const body = text.slice(0, TEXT_NOTE_MAX_CHARS);
    const title = titleFromText(body);
    const created = this.deps.repository.create({
      kind: request.kind ?? 'other',
      title,
      summary: '',
      body,
      fields: [],
      tags: [],
      // Authorship decides review (§4.2-2): the human typing it is the review.
      status: 'active',
      origin: 'user',
      scope: scope.scope,
      scopeKey: scope.scopeKey,
      sessionId: session.id,
      channel: session.channel && session.channel !== 'unknown' ? asChannel(session.channel) : null,
      captureId,
      // Provenance is the conversation it was said in, not a message: the sentence
      // may be a tidy-up of what the user meant, so citing a message id would
      // claim a quote that is not there.
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
    return { ok: true, captureId, notes: [created.note], redacted: 0, droppedRecaps: 0 };
  }

  /**
   * The last thing the user said in this session, for the "just keep this sentence"
   * dialog to start from. Returns null when the session has no user message yet — an
   * empty dialog is honest, a fabricated prefill is not.
   */
  prefillText(sessionId: string): string | null {
    const rows = this.readMessages(sessionId, 40);
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const message = rows[index];
      if (message.role !== 'user') continue;
      const text = message.content.trim();
      if (text) return text.slice(0, TEXT_NOTE_MAX_CHARS);
    }
    return null;
  }

  private runDistill(input: {
    windowText: string;
    windowIds: string[];
    maxNotes: number;
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
