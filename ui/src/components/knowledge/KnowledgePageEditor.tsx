import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ArrowLeft, RotateCcw, Save } from 'lucide-react';
import { formatRelativeTime } from '../../lib/utils';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Spinner from '../ui/Spinner';
import Textarea from '../ui/Textarea';
import { useToast } from '../ui/Toast';
import { KnowledgeApiError, fetchKnowledgePage, updateKnowledgePage } from './knowledge-api';
import KnowledgeScopeBadge from './KnowledgeScopeBadge';
import type { KnowledgeSelection } from './KnowledgePageList';
import type { KnowledgePageDetailPayload, KnowledgePagePatch, KnowledgePagePayload } from './types';

interface EditorForm {
  title: string;
  content: string;
  /** Comma-separated in the form, an array on the wire. */
  aliases: string;
  tags: string;
  /** Empty string = leave the stored value alone (the PUT accepts no `null`). */
  confidence: string;
}

/** A 409 that was refused, kept whole so the banner can show what we collided with. */
interface ConflictState {
  /** The patch the user was trying to write — re-applied unchanged on request. */
  patch: KnowledgePagePatch;
  currentVersion: number;
  currentContent: string;
}

function toForm(page: KnowledgePagePayload): EditorForm {
  return {
    title: page.title,
    content: page.content,
    aliases: page.aliases.join(', '),
    tags: page.tags.join(', '),
    confidence: page.confidence === null ? '' : String(page.confidence),
  };
}

function parseList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * The patch a save would send, or `null` when the form matches the loaded page.
 *
 * Only fields the user actually changed are sent. That is what makes "reload and
 * re-apply" safe: a draft that only retitled a page does not carry the stale
 * content along with it, so re-applying on top of a newer version leaves the
 * other side's content alone.
 */
function buildPatch(page: KnowledgePagePayload, form: EditorForm): KnowledgePagePatch | null {
  const patch: KnowledgePagePatch = { expectedVersion: page.version };
  let changed = false;

  const title = form.title.trim();
  if (title && title !== page.title) {
    patch.title = title;
    changed = true;
  }
  if (form.content !== page.content) {
    patch.content = form.content;
    changed = true;
  }
  const aliases = parseList(form.aliases);
  if (!sameList(aliases, page.aliases)) {
    patch.aliases = aliases;
    changed = true;
  }
  const tags = parseList(form.tags);
  if (!sameList(tags, page.tags)) {
    patch.tags = tags;
    changed = true;
  }
  const confidence = form.confidence.trim();
  if (confidence !== '') {
    const parsed = Number(confidence);
    // Out-of-range values are reported by the caller; comparing here keeps the
    // "nothing changed" check honest for a valid value.
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 && parsed !== page.confidence) {
      patch.confidence = parsed;
      changed = true;
    }
  }
  return changed ? patch : null;
}

interface KnowledgePageEditorProps {
  selection: KnowledgeSelection;
  /** Leaves the editor (mobile "back"; the parent clears the selection). */
  onClose: () => void;
  /** A save landed — the parent refetches the list and the counts. */
  onSaved: () => void;
  /**
   * The form has text that a save would write. The parent needs it because
   * switching pages unmounts this component and would drop the draft silently.
   */
  onDirtyChange: (dirty: boolean) => void;
}

/**
 * Detail view and editor for one page.
 *
 * `PUT /api/knowledge/page/:id` is guarded by `expectedVersion`, so the editor
 * always sends the version it loaded. A 409 is not an error toast: it opens a
 * conflict banner with the server's current content and an explicit choice,
 * because the alternative — saving over it, or reloading and losing the draft —
 * throws away one of the two edits.
 *
 * An archived page renders read-only from the list's own payload: `GET
 * /page/:id` is active-only by contract, so there is nothing to fetch and
 * nothing to edit — the body is kept for history.
 */
export default function KnowledgePageEditor({
  selection,
  onClose,
  onSaved,
  onDirtyChange,
}: KnowledgePageEditorProps) {
  const { t } = useTranslation('common');
  const { showToast } = useToast();

  const archivedPage = selection.page?.status === 'archived' ? selection.page : null;
  const readOnly = archivedPage !== null;

  const [detail, setDetail] = useState<KnowledgePageDetailPayload | null>(() =>
    archivedPage ? { page: archivedPage, sources: [], links: [], backlinks: [] } : null,
  );
  const [form, setForm] = useState<EditorForm | null>(() =>
    archivedPage ? toForm(archivedPage) : null,
  );
  const [loading, setLoading] = useState(!archivedPage);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<ConflictState | null>(null);

  const load = useCallback(async () => {
    try {
      const payload = await fetchKnowledgePage(selection.id);
      setDetail(payload);
      setForm(toForm(payload.page));
      setLoadError(null);
      return payload;
    } catch (err) {
      setDetail(null);
      setForm(null);
      setLoadError(
        err instanceof KnowledgeApiError && err.status === 404
          ? t('knowledge.editor.missing')
          : t('knowledge.editor.loadError'),
      );
      return null;
    }
  }, [selection.id, t]);

  useEffect(() => {
    if (readOnly) return;
    let cancelled = false;
    setLoading(true);
    setConflict(null);
    setLoadError(null);
    void load().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [load, readOnly]);

  const confidenceError = useMemo(() => {
    const raw = form?.confidence.trim() ?? '';
    if (raw === '') return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
      ? null
      : t('knowledge.editor.confidenceInvalid');
  }, [form?.confidence, t]);

  const titleError = form && !form.title.trim() ? t('knowledge.editor.titleRequired') : null;

  const patch = useMemo(
    () =>
      detail && form && !titleError && !confidenceError ? buildPatch(detail.page, form) : null,
    [detail, form, titleError, confidenceError],
  );

  useEffect(() => {
    onDirtyChange(patch !== null);
  }, [patch, onDirtyChange]);

  const submit = useCallback(
    async (next: KnowledgePagePatch) => {
      if (readOnly) return;
      setSaving(true);
      setConflict(null);
      try {
        const result = await updateKnowledgePage(selection.id, next);
        // The PUT only answers with the new version, and the reader needs the
        // server's authoritative body (links, formatted fields, version), so the
        // page is re-read rather than patched locally from what was typed.
        await load();
        onSaved();
        if (result.danglingLinks.length > 0) {
          showToast(
            t('knowledge.editor.dangling', { slugs: result.danglingLinks.join(', ') }),
            'info',
            6000,
          );
        } else {
          showToast(t('knowledge.editor.saved'), 'success');
        }
      } catch (err) {
        if (err instanceof KnowledgeApiError && err.isVersionConflict) {
          // Nothing was written. Keep the draft on screen and show both sides.
          setConflict({
            patch: next,
            currentVersion: err.body.currentVersion ?? detail?.page.version ?? 0,
            currentContent: err.body.currentContent ?? '',
          });
          return;
        }
        const message =
          err instanceof KnowledgeApiError && err.status === 400
            ? `${t('knowledge.editor.saveError')} ${err.message}`
            : t('knowledge.editor.saveError');
        showToast(message, 'error', 6000);
      } finally {
        setSaving(false);
      }
    },
    [detail?.page.version, load, onSaved, readOnly, selection.id, showToast, t],
  );

  /** Adopt the server's version and write the same patch onto it. */
  const handleReloadReapply = () => {
    if (!conflict) return;
    void submit({ ...conflict.patch, expectedVersion: conflict.currentVersion });
  };

  /** Throw the draft away and show what the server currently has. */
  const handleDiscardMine = () => {
    setConflict(null);
    if (!readOnly) void load();
  };

  const handleSave = () => {
    if (!patch) return;
    void submit(patch);
  };

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center py-16">
        <Spinner />
      </div>
    );
  }

  if (loadError || !detail || !form) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
        <p className="text-xs text-red-600 dark:text-red-400">{loadError}</p>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            {t('knowledge.retry')}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('knowledge.editor.back')}
          </Button>
        </div>
      </div>
    );
  }

  const page = detail.page;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-3 p-3 sm:p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">
              <span className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">
                {t(`knowledge.pageTypes.${page.pageType}`)}
              </span>
              <span className="truncate">{page.slug}</span>
              <span>·</span>
              <span>{t('knowledge.version', { version: page.version })}</span>
              <span>·</span>
              <span>{t(`knowledge.statuses.${page.status}`)}</span>
              {/* Beside the status: `global` here means the page is shared with
                  every chat, which is what a console edit leaves behind. */}
              <KnowledgeScopeBadge scope={page.scope} />
            </div>
            <p className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
              {page.updatedAt
                ? t('knowledge.editor.updated', {
                    time: formatRelativeTime(page.updatedAt),
                    actor: page.updatedBy || t('knowledge.editor.actorUnknown'),
                  })
                : ''}
            </p>
          </div>
          <Button variant="ghost" size="sm" className="sm:hidden" onClick={onClose}>
            <ArrowLeft size={14} />
            {t('knowledge.editor.back')}
          </Button>
        </div>

        {readOnly && (
          <p className="rounded-lg border border-neutral-200 bg-neutral-50 p-2.5 text-[11.5px] leading-relaxed text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
            {t('knowledge.editor.archivedNotice')}
          </p>
        )}

        {conflict && (
          <section
            role="alert"
            className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30"
          >
            <h2 className="flex items-center gap-1.5 text-[13px] font-semibold text-amber-800 dark:text-amber-200">
              <AlertTriangle size={14} strokeWidth={1.75} />
              {t('knowledge.conflict.title')}
            </h2>
            <p className="text-xs leading-relaxed text-amber-800 dark:text-amber-200">
              {t('knowledge.conflict.body', {
                baseVersion: page.version,
                currentVersion: conflict.currentVersion,
              })}
            </p>
            <div>
              <p className="mb-1 text-[11px] font-medium text-amber-800 dark:text-amber-200">
                {t('knowledge.conflict.currentContentLabel')}
              </p>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-amber-200 bg-white p-2 text-[11.5px] leading-relaxed text-neutral-800 dark:border-amber-900 dark:bg-neutral-900 dark:text-neutral-200">
                {conflict.currentContent || t('knowledge.conflict.emptyContent')}
              </pre>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={handleReloadReapply} loading={saving}>
                {t('knowledge.conflict.reloadReapply')}
              </Button>
              <Button variant="secondary" size="sm" onClick={handleDiscardMine} disabled={saving}>
                {t('knowledge.conflict.discardMine')}
              </Button>
            </div>
            <p className="text-[11px] text-amber-700 dark:text-amber-300">
              {t('knowledge.conflict.reloadReapplyHint')}
            </p>
          </section>
        )}

        <Input
          label={t('knowledge.editor.titleLabel')}
          value={form.title}
          disabled={readOnly}
          className={readOnly ? 'opacity-70' : undefined}
          error={titleError ?? undefined}
          placeholder={t('knowledge.editor.titlePlaceholder')}
          onChange={(event) => setForm({ ...form, title: event.target.value })}
        />

        <Textarea
          label={t('knowledge.editor.contentLabel')}
          value={form.content}
          rows={16}
          disabled={readOnly}
          placeholder={t('knowledge.editor.contentPlaceholder')}
          className={`font-mono text-[12.5px] leading-relaxed ${readOnly ? 'opacity-70' : ''}`}
          onChange={(event) => setForm({ ...form, content: event.target.value })}
        />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input
            label={t('knowledge.editor.aliasesLabel')}
            value={form.aliases}
            disabled={readOnly}
            className={readOnly ? 'opacity-70' : undefined}
            placeholder={t('knowledge.editor.aliasesHint')}
            onChange={(event) => setForm({ ...form, aliases: event.target.value })}
          />
          <Input
            label={t('knowledge.editor.tagsLabel')}
            value={form.tags}
            disabled={readOnly}
            className={readOnly ? 'opacity-70' : undefined}
            placeholder={t('knowledge.editor.tagsHint')}
            onChange={(event) => setForm({ ...form, tags: event.target.value })}
          />
        </div>

        <Input
          label={t('knowledge.editor.confidenceLabel')}
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={form.confidence}
          disabled={readOnly}
          className={readOnly ? 'opacity-70' : undefined}
          placeholder={t('knowledge.editor.confidenceHint')}
          error={confidenceError ?? undefined}
          onChange={(event) => setForm({ ...form, confidence: event.target.value })}
        />

        {!readOnly && (
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={handleSave} loading={saving} disabled={!patch}>
              <Save size={14} strokeWidth={1.75} />
              {t('knowledge.editor.save')}
            </Button>
            <Button
              variant="secondary"
              disabled={!patch || saving}
              onClick={() => setForm(toForm(page))}
            >
              <RotateCcw size={14} strokeWidth={1.75} />
              {t('knowledge.editor.reset')}
            </Button>
            <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
              {patch ? t('knowledge.editor.dirtyHint') : t('knowledge.editor.cleanHint')}
            </span>
          </div>
        )}

        {/* Sources, links and backlinks come from the detail endpoint, which does
            not serve an archived page; an empty list here would read as "none
            recorded". */}
        {!readOnly && (
          <>
            <section className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
              <h2 className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200">
                {t('knowledge.editor.sourcesLabel')}
              </h2>
              {detail.sources.length === 0 ? (
                <p className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                  {t('knowledge.editor.sourcesEmpty')}
                </p>
              ) : (
                <ul className="mt-1 space-y-0.5">
                  {detail.sources.map((source) => (
                    <li
                      key={`${source.kind}-${source.id}`}
                      className="flex items-baseline gap-2 text-[11.5px]"
                    >
                      <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                        {source.kind}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-neutral-700 dark:text-neutral-300">
                        {source.id}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
              <h2 className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200">
                {t('knowledge.editor.linksLabel')}
              </h2>
              {detail.links.length === 0 ? (
                <p className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                  {t('knowledge.editor.linksEmpty')}
                </p>
              ) : (
                <ul className="mt-1 flex flex-wrap gap-1.5">
                  {detail.links.map((link) => (
                    <li
                      key={link.slug}
                      title={link.missing ? t('knowledge.editor.linkMissing') : link.slug}
                      className={`rounded px-1.5 py-0.5 text-[11px] ${
                        link.missing
                          ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
                          : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'
                      }`}
                    >
                      {link.label || link.slug}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Backlinks are the pages that cite this one, read from the link
                table rather than parsed from a body, so they always name a page
                that exists and is active. */}
            <section className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
              <h2 className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200">
                {t('knowledge.editor.backlinksLabel')}
              </h2>
              {detail.backlinks.length === 0 ? (
                <p className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                  {t('knowledge.editor.backlinksEmpty')}
                </p>
              ) : (
                <ul className="mt-1 space-y-0.5">
                  {detail.backlinks.map((backlink) => (
                    <li
                      key={backlink.slug}
                      className="flex items-baseline gap-2 text-[11.5px]"
                      title={
                        backlink.label ? `${backlink.label} → ${backlink.slug}` : backlink.slug
                      }
                    >
                      <span className="min-w-0 flex-1 truncate text-neutral-700 dark:text-neutral-300">
                        {backlink.title}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-neutral-500 dark:text-neutral-400">
                        {backlink.slug}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
