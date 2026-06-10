import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Filter, ChevronDown, ChevronRight, Pencil, Trash2, X, Save, User } from 'lucide-react';
import { apiRequest } from '../../utils/api';
import { useToast } from '../ui/Toast';
import Input from '../ui/Input';
import Select from '../ui/Select';
import Button from '../ui/Button';
import Textarea from '../ui/Textarea';
import Spinner from '../ui/Spinner';
import Toggle from '../ui/Toggle';
import { formatRelativeTime } from '../../lib/utils';

interface MemoryItem {
  id: string;
  scope: string;
  scope_key: string;
  kind: string;
  content: string;
  agent_id?: string;
  visibility: string;
  status: string;
  confidence: number;
  source_channel?: string;
  created_at: string;
  updated_at: string;
}

export default function MemoryView() {
  const { t } = useTranslation('common');
  const { showToast } = useToast();
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [scopeFilter, setScopeFilter] = useState('all');
  const [projectFilter, setProjectFilter] = useState('all');
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [selectedMemory, setSelectedMemory] = useState<MemoryItem | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [page, setPage] = useState(0);

  // Persona state
  const [persona, setPersona] = useState<Record<string, unknown> | null>(null);
  const [personaLoading, setPersonaLoading] = useState(false);
  const [personaSaving, setPersonaSaving] = useState(false);
  const [showPersona, setShowPersona] = useState(false);
  const [personaForm, setPersonaForm] = useState<Record<string, string>>({});

  const PERSONA_DRAFT_KEY = 'oma-persona-draft';

  const fetchPersona = useCallback(async () => {
    try {
      setPersonaLoading(true);
      const data = await apiRequest<Record<string, unknown>>('/api/persona');
      setPersona(data && Object.keys(data).length > 0 ? data : null);
      // Restore draft from localStorage (takes priority over saved data)
      const draft = localStorage.getItem(PERSONA_DRAFT_KEY);
      if (draft) {
        try { setPersonaForm(JSON.parse(draft)); return; } catch { /* ignore */ }
      }
      if (data) {
        const form = {
          summary: String(data.summary || ''),
          communication: String((data as any).preferences?.communication || ''),
          tools: String((data as any).preferences?.tools?.join(', ') || ''),
          languages: String((data as any).preferences?.languages?.join(', ') || ''),
          workflows: String((data as any).preferences?.workflows?.join(', ') || ''),
          known_skills: String((data as any).skills?.known?.join(', ') || ''),
          learning_skills: String((data as any).skills?.learning?.join(', ') || ''),
          device: String((data as any).context?.device || ''),
          environment: String((data as any).context?.environment || ''),
        };
        setPersonaForm(form);
      }
    } catch { /* silent */ }
    finally { setPersonaLoading(false); }
  }, []);

  useEffect(() => { fetchPersona(); }, [fetchPersona]);

  // Persist draft to localStorage on every form change
  useEffect(() => {
    if (showPersona && Object.keys(personaForm).length > 0) {
      localStorage.setItem(PERSONA_DRAFT_KEY, JSON.stringify(personaForm));
    }
  }, [personaForm, showPersona]);

  const handlePersonaSave = async () => {
    setPersonaSaving(true);
    try {
      const payload = {
        summary: personaForm.summary || '',
        preferences: {
          communication: personaForm.communication || '',
          tools: (personaForm.tools || '').split(',').map((s: string) => s.trim()).filter(Boolean),
          languages: (personaForm.languages || '').split(',').map((s: string) => s.trim()).filter(Boolean),
          workflows: (personaForm.workflows || '').split(',').map((s: string) => s.trim()).filter(Boolean),
        },
        skills: {
          known: (personaForm.known_skills || '').split(',').map((s: string) => s.trim()).filter(Boolean),
          learning: (personaForm.learning_skills || '').split(',').map((s: string) => s.trim()).filter(Boolean),
        },
        context: {
          device: personaForm.device || '',
          environment: personaForm.environment || '',
        },
      };
      await apiRequest('/api/persona', { method: 'PUT', body: JSON.stringify(payload) });
      localStorage.removeItem(PERSONA_DRAFT_KEY);
      showToast(t('cron.saved'), 'success');
      await fetchPersona();
    } catch { showToast(t('cron.saveError'), 'error'); }
    finally { setPersonaSaving(false); }
  };

  const fetchMemories = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (searchQuery) params.set('q', searchQuery);
      if (scopeFilter !== 'all') params.set('scope', scopeFilter);
      if (projectFilter !== 'all') params.set('project_id', projectFilter);
      params.set('offset', String(page * 20));
      params.set('limit', '20');

      const data = await apiRequest<MemoryItem[]>(`/api/memory?${params.toString()}`);
      setMemories(data);
    } catch {
      // Fallback: empty list
      setMemories([]);
    } finally {
      setLoading(false);
    }
  }, [searchQuery, scopeFilter, projectFilter, page]);

  useEffect(() => { fetchMemories(); }, [fetchMemories]);

  useEffect(() => {
    apiRequest<{ id: string; name: string }[]>('/api/projects')
      .then(setProjects)
      .catch(() => {});
  }, []);

  const handleDelete = async (id: string) => {
    try {
      await apiRequest(`/api/memory/${id}`, { method: 'DELETE' });
      showToast(t('project.deleted'), 'success');
      fetchMemories();
    } catch { showToast(t('project.deleteError'), 'error'); }
  };

  const handleSave = async () => {
    if (!selectedMemory) return;
    try {
      await apiRequest(`/api/memory/${selectedMemory.id}`, {
        method: 'PUT',
        body: JSON.stringify({ content: editingContent }),
      });
      showToast(t('cron.saved'), 'success');
      setIsEditing(false);
      fetchMemories();
    } catch { showToast(t('cron.saveError'), 'error'); }
  };

  const scopeColors: Record<string, string> = {
    project: 'bg-blue-50 text-blue-600 dark:bg-blue-950/40 dark:text-blue-300',
    session: 'bg-purple-50 text-purple-600 dark:bg-purple-950/40 dark:text-purple-300',
    agent: 'bg-green-50 text-green-600 dark:bg-green-950/40 dark:text-green-300',
    user: 'bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-300',
    system: 'bg-rose-50 text-rose-600 dark:bg-rose-950/40 dark:text-rose-300',
  };

  return (
    <div className="h-full overflow-y-auto px-4 sm:px-8 py-4 sm:py-6">
      <h1 className="text-xl sm:text-2xl font-bold mb-4 sm:mb-6">{t('memory.title')}</h1>

      {/* Persona Section */}
      <div className="mb-6 rounded-lg border border-neutral-200 dark:border-neutral-800 overflow-hidden">
        <button
          type="button"
          onClick={() => setShowPersona(!showPersona)}
          className="flex w-full items-center gap-2 px-4 py-2.5 text-sm font-medium text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700/60 transition-colors"
        >
          <User className="h-4 w-4" strokeWidth={1.75} />
          <span>Persona</span>
          {persona && !showPersona && (
            <span className="text-[11px] text-neutral-400 dark:text-neutral-500 truncate max-w-[300px] ml-2">
              {String((persona as any)?.summary || '').slice(0, 80)}
            </span>
          )}
          {showPersona ? <ChevronDown size={14} className="ml-auto" /> : <ChevronRight size={14} className="ml-auto" />}
        </button>
        {showPersona && (
          <div className="px-4 py-3 space-y-4 border-t border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 max-h-[50vh] overflow-y-auto">
            {personaLoading ? (
              <div className="flex justify-center py-4"><Spinner /></div>
            ) : (
              <>
                <Textarea
                  label="Summary"
                  value={personaForm.summary || ''}
                  onChange={(e) => setPersonaForm((p) => ({ ...p, summary: e.target.value }))}
                  placeholder="Brief summary of the user..."
                />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Input
                    label="Communication"
                    value={personaForm.communication || ''}
                    onChange={(e) => setPersonaForm((p) => ({ ...p, communication: e.target.value }))}
                    placeholder="e.g. 称呼用户为小明；回复简洁直接"
                  />
                  <Input
                    label="Device"
                    value={personaForm.device || ''}
                    onChange={(e) => setPersonaForm((p) => ({ ...p, device: e.target.value }))}
                    placeholder="e.g. Android phone, MacBook Pro"
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Input
                    label="Tools (comma separated)"
                    value={personaForm.tools || ''}
                    onChange={(e) => setPersonaForm((p) => ({ ...p, tools: e.target.value }))}
                    placeholder="e.g. vscode, git, docker"
                  />
                  <Input
                    label="Languages (comma separated)"
                    value={personaForm.languages || ''}
                    onChange={(e) => setPersonaForm((p) => ({ ...p, languages: e.target.value }))}
                    placeholder="e.g. TypeScript, Python, Go"
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Input
                    label="Known Skills (comma separated)"
                    value={personaForm.known_skills || ''}
                    onChange={(e) => setPersonaForm((p) => ({ ...p, known_skills: e.target.value }))}
                    placeholder="e.g. React, Node.js, SQL"
                  />
                  <Input
                    label="Learning (comma separated)"
                    value={personaForm.learning_skills || ''}
                    onChange={(e) => setPersonaForm((p) => ({ ...p, learning_skills: e.target.value }))}
                    placeholder="e.g. Rust, Kubernetes"
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Input
                    label="Workflows (comma separated)"
                    value={personaForm.workflows || ''}
                    onChange={(e) => setPersonaForm((p) => ({ ...p, workflows: e.target.value }))}
                    placeholder="e.g. TDD, code review"
                  />
                  <Input
                    label="Environment"
                    value={personaForm.environment || ''}
                    onChange={(e) => setPersonaForm((p) => ({ ...p, environment: e.target.value }))}
                    placeholder="e.g. WSL2, Ubuntu 22.04"
                  />
                </div>
                <div className="flex justify-end">
                  <Button variant="primary" size="sm" onClick={handlePersonaSave} loading={personaSaving}>
                    <Save className="h-3.5 w-3.5" strokeWidth={1.75} />
                    <span>{t('common.save')}</span>
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Search & Filters */}
      <div className="flex flex-wrap items-center gap-2 sm:gap-3 mb-4">
        <div className="relative flex-1 min-w-[160px] max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500 dark:text-neutral-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setPage(0); }}
            placeholder={t('memory.search')}
            className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 pl-9 pr-3 py-2 text-sm focus:border-primary focus:outline-none"
          />
        </div>
        <div className="flex gap-2">
        <Select
          value={scopeFilter}
          onChange={(e) => { setScopeFilter(e.target.value); setPage(0); }}
          options={[
            { value: 'all', label: t('memory.all') },
            { value: 'project', label: t('memory.projectScope') },
            { value: 'session', label: t('memory.sessionScope') },
          ]}
          className="w-[110px] sm:w-[140px]"
        />
        <Select
          value={projectFilter}
          onChange={(e) => { setProjectFilter(e.target.value); setPage(0); }}
          options={[
            { value: 'all', label: t('memory.filterProject') + ': ' + t('memory.all') },
            ...projects.map((p) => ({ value: p.id, label: p.name })),
          ]}
          className="w-[140px] sm:w-[180px]"
        />
        </div>
      </div>

      {/* Memory List */}
      {loading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : memories.length === 0 ? (
        <div className="text-center py-12 text-neutral-500 dark:text-neutral-400 text-sm">{t('memory.noResults')}</div>
      ) : (
        <div className="space-y-2">
          {memories.map((mem) => (
            <div
              key={mem.id}
              className={`rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 cursor-pointer hover:shadow-sm transition-shadow ${
                selectedMemory?.id === mem.id ? 'ring-2 ring-primary' : ''
              }`}
              onClick={() => { setSelectedMemory(mem); setIsEditing(false); }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-neutral-900 dark:text-neutral-100 line-clamp-2">{mem.content}</p>
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${scopeColors[mem.scope] || 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300'}`}>
                      {mem.scope}
                    </span>
                    <span className="text-xs text-neutral-500 dark:text-neutral-400">{mem.kind}</span>
                    {mem.confidence < 1 && (
                      <span className="text-xs text-warning">{Math.round(mem.confidence * 100)}%</span>
                    )}
                    <span className="text-xs text-neutral-500 dark:text-neutral-400">{formatRelativeTime(mem.created_at)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                  <button className="p-1 hover:bg-neutral-100 dark:bg-neutral-800 rounded" onClick={() => { setSelectedMemory(mem); setEditingContent(mem.content); setIsEditing(true); }}>
                    <Pencil size={14} />
                  </button>
                  <button className="p-1 hover:bg-neutral-100 dark:bg-neutral-800 rounded text-danger" onClick={() => handleDelete(mem.id)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {memories.length === 20 && (
        <div className="flex justify-center gap-3 mt-4">
          <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>{t("common.prev_page")}</Button>
          <Button variant="secondary" size="sm" onClick={() => setPage(page + 1)}>{t("common.next_page")}</Button>
        </div>
      )}

      {/* Detail Drawer */}
      {selectedMemory && (
        <div className="fixed inset-y-0 right-0 z-[90] w-full sm:w-[400px] max-w-full sm:max-w-[90vw] bg-white dark:bg-neutral-900 border-l border-neutral-200 dark:border-neutral-800 shadow-2xl overflow-y-auto">
          <div className="flex items-center justify-between p-4 border-b border-neutral-200 dark:border-neutral-800">
            <h3 className="font-semibold">{t("memory_page.detail")}</h3>
            <div className="flex items-center gap-1">
              {!isEditing && (
                <button className="p-1.5 hover:bg-neutral-100 dark:bg-neutral-800 rounded" onClick={() => { setEditingContent(selectedMemory.content); setIsEditing(true); }}>
                  <Pencil size={16} />
                </button>
              )}
              <button className="p-1.5 hover:bg-neutral-100 dark:bg-neutral-800 rounded" onClick={() => setSelectedMemory(null)}>
                <X size={16} />
              </button>
            </div>
          </div>

          <div className="p-4 space-y-4">
            {isEditing ? (
              <>
                <Textarea label={t("memory_page.content")} value={editingContent} onChange={(e) => setEditingContent(e.target.value)} rows={6} />
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleSave}>{t("memory_page.save")}</Button>
                  <Button variant="secondary" size="sm" onClick={() => setIsEditing(false)}>{t("memory_page.cancel")}</Button>
                </div>
              </>
            ) : (
              <p className="text-sm whitespace-pre-wrap">{selectedMemory.content}</p>
            )}

            <div className="space-y-2 text-sm border-t border-neutral-200 dark:border-neutral-800 pt-3">
              <div className="flex justify-between"><span className="text-neutral-500 dark:text-neutral-400">Scope</span><span>{selectedMemory.scope}</span></div>
              <div className="flex justify-between"><span className="text-neutral-500 dark:text-neutral-400">Scope Key</span><span className="text-xs font-mono">{selectedMemory.scope_key}</span></div>
              <div className="flex justify-between"><span className="text-neutral-500 dark:text-neutral-400">Kind</span><span>{selectedMemory.kind}</span></div>
              <div className="flex justify-between"><span className="text-neutral-500 dark:text-neutral-400">Confidence</span><span>{selectedMemory.confidence}</span></div>
              <div className="flex justify-between"><span className="text-neutral-500 dark:text-neutral-400">Visibility</span><span>{selectedMemory.visibility}</span></div>
              <div className="flex justify-between"><span className="text-neutral-500 dark:text-neutral-400">Status</span><span>{selectedMemory.status}</span></div>
              {selectedMemory.agent_id && <div className="flex justify-between"><span className="text-neutral-500 dark:text-neutral-400">Agent</span><span>{selectedMemory.agent_id}</span></div>}
              <div className="flex justify-between"><span className="text-neutral-500 dark:text-neutral-400">Created</span><span>{formatRelativeTime(selectedMemory.created_at)}</span></div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
