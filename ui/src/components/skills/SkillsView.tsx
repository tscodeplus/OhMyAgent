import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Loader2, Plus, RefreshCw, Save, Sparkles, Store, Trash2 } from 'lucide-react';
import { apiRequest } from '../../utils/api';
import { useToast } from '../ui/Toast';
import Modal from '../ui/Modal';
import Input from '../ui/Input';
import Button from '../ui/Button';
import Spinner from '../ui/Spinner';
import SkillMarketplace from './SkillMarketplace';

interface Skill {
  slug: string;
  name: string;
  description: string;
  version: string;
  path: string;
}

interface SkillsListResponse {
  skills: Skill[];
}

interface SkillDetailResponse {
  slug: string;
  name: string;
  description: string;
  path: string;
  content: string;
}

type SkillsTab = 'manage' | 'marketplace';

export default function SkillsView() {
  const { t } = useTranslation('common');
  const { showToast } = useToast();

  const [activeTab, setActiveTab] = useState<SkillsTab>('manage');

  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [editorContent, setEditorContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [saving, setSaving] = useState(false);

  // New skill form
  const [showNewModal, setShowNewModal] = useState(false);
  const [newSlug, setNewSlug] = useState('');
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);

  const isDirty = editorContent !== originalContent;

  // Mobile: toggle between list and editor
  const [mobileShowEditor, setMobileShowEditor] = useState(false);

  // ---- Fetch skills list ----
  const fetchSkills = useCallback(async () => {
    try {
      const data = await apiRequest<SkillsListResponse>('/api/skills');
      setSkills(data.skills || []);
    } catch {
      showToast(t('skills.loadError'), 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast, t]);

  useEffect(() => { void fetchSkills(); }, [fetchSkills]);

  // ---- Load skill content ----
  useEffect(() => {
    if (!activeSlug) {
      setEditorContent('');
      setOriginalContent('');
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    apiRequest<SkillDetailResponse>(`/api/skills/${activeSlug}`)
      .then((data) => {
        if (cancelled) return;
        if (data.content !== undefined) {
          setEditorContent(data.content);
          setOriginalContent(data.content);
        }
      })
      .catch(() => {
        if (!cancelled) showToast(t('skills.loadError'), 'error');
      })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [activeSlug, showToast, t]);

  // ---- Save ----
  const handleSave = useCallback(async () => {
    if (!activeSlug) return;
    setSaving(true);
    try {
      await apiRequest(`/api/skills/${activeSlug}`, {
        method: 'PUT',
        body: JSON.stringify({ content: editorContent }),
      });
      setOriginalContent(editorContent);
      await fetchSkills();
      showToast(t('skills.savedSuccess'), 'success');
    } catch (e) {
      showToast((e as Error).message || t('skills.saveError'), 'error');
    } finally {
      setSaving(false);
    }
  }, [activeSlug, editorContent, fetchSkills, showToast, t]);

  // ---- Delete ----
  const handleDelete = useCallback(() => {
    if (!activeSlug) return;

    const performDelete = async () => {
      try {
        await apiRequest(`/api/skills/${activeSlug}`, { method: 'DELETE' });
        setActiveSlug(null);
        await fetchSkills();
        showToast(t('skills.deletedSuccess'), 'success');
      } catch {
        showToast(t('skills.saveError'), 'error');
      }
    };

    showToast(
      t('skills.confirmDelete') as string,
      'info',
      0, // sticky — won't auto-dismiss
      [
        { label: t('common.cancel') as string, onClick: () => {} },
        { label: t('common.confirm') as string, onClick: performDelete, danger: true },
      ],
    );
  }, [activeSlug, fetchSkills, showToast, t]);

  // ---- Create ----
  const handleCreate = useCallback(async () => {
    if (!newSlug.trim() || !newName.trim()) return;
    setCreating(true);
    try {
      await apiRequest('/api/skills', {
        method: 'POST',
        body: JSON.stringify({ slug: newSlug.trim(), name: newName.trim(), description: newDesc.trim() }),
      });
      setShowNewModal(false);
      setNewSlug(''); setNewName(''); setNewDesc('');
      await fetchSkills();
      setActiveSlug(newSlug.trim());
      showToast(t('skills.createdSuccess'), 'success');
    } catch (e) {
      showToast((e as Error).message || t('skills.saveError'), 'error');
    } finally {
      setCreating(false);
    }
  }, [newSlug, newName, newDesc, fetchSkills, showToast, t]);

  // ---- Handle select with unsaved check ----
  const handleSelect = useCallback((skill: Skill) => {
    if (isDirty) {
      if (!window.confirm(t('skills.confirmDiscard') as string)) return;
    }
    setActiveSlug(skill.slug);
    setMobileShowEditor(true);
  }, [isDirty, t]);

  const handleBackToList = useCallback(() => {
    if (isDirty) {
      if (!window.confirm(t('skills.confirmDiscard') as string)) return;
    }
    setMobileShowEditor(false);
    setActiveSlug(null);
  }, [isDirty, t]);

  // Callback from marketplace after install — refresh the local skill list
  const handleMarketplaceInstall = useCallback(() => {
    fetchSkills();
  }, [fetchSkills]);

  const activeSkill = useMemo(
    () => skills.find((s) => s.slug === activeSlug),
    [skills, activeSlug],
  );

  // ── Sub-tab definitions ──────────────────────────────────────────────────

  const subTabs: { id: SkillsTab; labelKey: string; icon: typeof Sparkles }[] = [
    { id: 'manage', labelKey: 'skills.tabManage', icon: Sparkles },
    { id: 'marketplace', labelKey: 'skills.tabMarketplace', icon: Store },
  ];

  return (
    <div className="flex h-full flex-col bg-white dark:bg-neutral-950">
      {/* Header with sub-tabs */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-neutral-200 px-3 sm:px-6 dark:border-neutral-800">
        <div className="flex items-center gap-3">
          {subTabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors ${
                  isActive
                    ? 'bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
                    : 'text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200'
                }`}
              >
                <Icon className={`h-3.5 w-3.5 ${tab.id === 'manage' ? 'text-amber-500' : 'text-violet-500'}`} strokeWidth={1.75} />
                <span>{t(tab.labelKey)}</span>
              </button>
            );
          })}
        </div>

        {/* Actions — only shown on manage tab */}
        {activeTab === 'manage' && (
          <div className="flex items-center gap-1">
            <button type="button" onClick={fetchSkills} disabled={loading}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-600 transition hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-900"
              title={t('files.refresh') as string}>
              <RefreshCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} strokeWidth={1.75} />
            </button>
            <Button size="sm" onClick={() => setShowNewModal(true)}>
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span>{t('skills.newSkill')}</span>
            </Button>
          </div>
        )}
      </div>

      {/* ── Manage Tab ────────────────────────────────────────────────────── */}
      {activeTab === 'manage' && (
        <div className="flex min-h-0 flex-1">
          {/* Left: Skill List — hidden on mobile when editor is shown */}
          <div className={`flex w-72 max-sm:w-full shrink-0 flex-col border-r max-sm:border-r-0 border-neutral-200 dark:border-neutral-800 ${mobileShowEditor ? 'max-sm:hidden' : ''}`}>
            <div className="min-h-0 flex-1 overflow-y-auto py-2 text-[13px]">
              {loading ? (
                <div className="flex items-center justify-center gap-2 py-6 text-neutral-500 dark:text-neutral-400">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
                  <span>{t('common.loading')}</span>
                </div>
              ) : skills.length === 0 ? (
                <div className="px-4 py-6 text-center text-neutral-500 dark:text-neutral-400">
                  {t('skills.empty')}
                </div>
              ) : (
                <div className="space-y-0.5 px-3">
                  {skills.map((skill) => (
                    <button key={skill.slug} type="button" onClick={() => handleSelect(skill)}
                      className={`group/skill flex w-full items-start gap-2 rounded-md px-3 py-2 text-left transition-colors ${
                        activeSlug === skill.slug
                          ? 'bg-neutral-100 dark:bg-neutral-800'
                          : 'hover:bg-neutral-50 dark:hover:bg-neutral-900/60'
                      }`}>
                      <div className="min-w-0 flex-1">
                        <div className={`truncate text-[13px] font-medium ${
                          activeSlug === skill.slug ? 'text-neutral-900 dark:text-neutral-100' : 'text-neutral-700 dark:text-neutral-300'
                        }`}>{skill.name}</div>
                        <div className="truncate text-[11px] text-neutral-500 dark:text-neutral-400">{skill.description}</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Right: Editor — shown on desktop always, on mobile only when editor is active */}
          <div className={`flex min-h-0 flex-1 flex-col ${!mobileShowEditor ? 'max-sm:hidden' : ''}`}>
            {activeSkill ? (
              <>
                {/* Info bar */}
                <div className="shrink-0 border-b border-neutral-200 px-4 sm:px-6 py-2 dark:border-neutral-800 flex items-center gap-2">
                  {/* Back button on mobile */}
                  <button type="button" onClick={handleBackToList}
                    className="inline-flex sm:hidden h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800">
                    <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </button>
                  <div className="min-w-0">
                    <h2 className="text-[14px] font-semibold text-neutral-900 dark:text-neutral-100 truncate">{activeSkill.name}</h2>
                    <p className="text-[11px] text-neutral-400 dark:text-neutral-500 font-mono truncate">{activeSkill.path}</p>
                  </div>
                </div>
                {/* Editor */}
                <div className="min-h-0 flex-1 overflow-hidden p-4">
                  {detailLoading ? (
                    <div className="flex items-center justify-center py-12"><Spinner /></div>
                  ) : (
                    <textarea
                      value={editorContent}
                      onChange={(e) => setEditorContent(e.target.value)}
                      className="w-full h-full resize-none rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 font-mono"
                    />
                  )}
                </div>
                {/* Footer */}
                <div className="flex shrink-0 items-center justify-between border-t border-neutral-200 px-4 sm:px-6 py-2 dark:border-neutral-800">
                  <Button variant="danger" size="sm" onClick={handleDelete}>
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                    <span>{t('skills.delete')}</span>
                  </Button>
                  <div className="flex items-center gap-2">
                    {isDirty && (
                      <Button variant="ghost" size="sm" onClick={() => setEditorContent(originalContent)}>
                        {t('skills.revert')}
                      </Button>
                    )}
                    <Button variant="primary" size="sm" onClick={handleSave} loading={saving} disabled={!isDirty}>
                      <Save className="h-3.5 w-3.5" strokeWidth={1.75} />
                      <span>{t('skills.save')}</span>
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-[13px] text-neutral-500 dark:text-neutral-400 max-sm:hidden">
                {skills.length > 0 ? t('skills.selectPrompt', { defaultValue: 'Select a skill to edit' }) : t('skills.empty')}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Marketplace Tab ───────────────────────────────────────────────── */}
      {activeTab === 'marketplace' && (
        <div className="flex min-h-0 flex-1">
          <SkillMarketplace onInstall={handleMarketplaceInstall} />
        </div>
      )}

      {/* New Skill Modal */}
      {showNewModal && (
        <Modal open={showNewModal} onClose={() => setShowNewModal(false)} title={t('skills.createSkill') as string} size="md"
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setShowNewModal(false)}>{t('common.cancel')}</Button>
              <Button variant="primary" size="sm" onClick={handleCreate} loading={creating} disabled={!newSlug.trim() || !newName.trim()}>
                {t('skills.createSkill')}
              </Button>
            </div>
          }>
          <div className="space-y-4">
            <Input label={t('skills.slug')} value={newSlug} onChange={(e) => setNewSlug(e.target.value)} placeholder={t('skills.slugPlaceholder') as string} />
            <Input label={t('skills.name')} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('skills.namePlaceholder') as string} />
            <Input label={t('skills.description')} value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder={t('skills.descriptionPlaceholder') as string} />
          </div>
        </Modal>
      )}
    </div>
  );
}
