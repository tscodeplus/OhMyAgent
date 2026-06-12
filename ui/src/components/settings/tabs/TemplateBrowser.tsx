import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { apiRequest } from '../../../utils/api';
import { useToast } from '../../ui/Toast';
import Modal from '../../ui/Modal';
import Button from '../../ui/Button';
import Spinner from '../../ui/Spinner';
import { Search } from 'lucide-react';

// ── Types ───────────────────────────────────────────────────────────

interface TemplateEntry {
  id: string;
  source: 'en' | 'zh';
  name: string;
  description: string;
  division: string;
  filePath: string;
  emoji?: string;
  color?: string;
}

interface TemplateListResponse {
  templates: TemplateEntry[];
  divisions: string[];
}

interface TemplateContentResponse {
  id: string;
  name: string;
  description: string;
  content: string;
  emoji?: string;
}

interface TemplateBrowserProps {
  open: boolean;
  onClose: () => void;
  onImport: (template: { name: string; systemPrompt: string; description?: string }) => void;
}

// ── Component ───────────────────────────────────────────────────────

export default function TemplateBrowser({ open, onClose, onImport }: TemplateBrowserProps) {
  const { t } = useTranslation('common');
  const { showToast } = useToast();

  // Filters
  const [source, setSource] = useState<'en' | 'zh'>('en');
  const [division, setDivision] = useState('');
  const [search, setSearch] = useState('');

  // Data
  const [templates, setTemplates] = useState<TemplateEntry[]>([]);
  const [divisions, setDivisions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  // Selection & preview
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewName, setPreviewName] = useState('');
  const [previewDesc, setPreviewDesc] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);

  const prefix = 'settings.agents';

  // ── Fetch template list ──────────────────────────────────────────

  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    setSelectedId(null);
    setPreviewContent(null);
    try {
      const params = new URLSearchParams({ source });
      if (division) params.set('division', division);
      if (search.trim()) params.set('search', search.trim());
      const data = await apiRequest<TemplateListResponse>(`/api/templates?${params.toString()}`);
      setTemplates(data.templates);
      setDivisions(data.divisions);
    } catch {
      showToast(t(`${prefix}.templateLoadError`), 'error');
    } finally {
      setLoading(false);
    }
  }, [source, division, search, showToast, t, prefix]);

  useEffect(() => {
    if (open) {
      fetchTemplates();
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refetch when filters change
  useEffect(() => {
    if (open) {
      const timer = setTimeout(fetchTemplates, 300);
      return () => clearTimeout(timer);
    }
  }, [source, division, search, open, fetchTemplates]);

  // Reset when modal opens
  useEffect(() => {
    if (open) {
      setSelectedId(null);
      setPreviewContent(null);
      setSearch('');
      setDivision('');
    }
  }, [open]);

  // ── Preview ──────────────────────────────────────────────────────

  const handleSelect = async (template: TemplateEntry) => {
    setSelectedId(template.id);
    setPreviewLoading(true);
    setPreviewContent(null);
    try {
      const data = await apiRequest<TemplateContentResponse>(
        `/api/templates/content?source=${template.source}&path=${encodeURIComponent(template.filePath)}`
      );
      setPreviewContent(data.content);
      setPreviewName(data.name);
      setPreviewDesc(data.description);
    } catch {
      showToast(t(`${prefix}.templateContentLoadError`), 'error');
    } finally {
      setPreviewLoading(false);
    }
  };

  // ── Import ───────────────────────────────────────────────────────

  const handleImport = () => {
    const selected = templates.find((t) => t.id === selectedId);
    if (!selected || previewContent === null) return;
    onImport({
      name: previewName || selected.name,
      systemPrompt: previewContent,
      description: previewDesc || selected.description,
    });
    showToast(t(`${prefix}.templateImportSuccess`), 'success');
    onClose();
  };

  const selectedTemplate = templates.find((t) => t.id === selectedId);
  const canImport = selectedId && previewContent !== null && !previewLoading;

  // ── Render ───────────────────────────────────────────────────────

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t(`${prefix}.templateBrowserTitle`)}
      size="full"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={handleImport} disabled={!canImport}>
            {t(`${prefix}.templateImport`)}
          </Button>
        </>
      }
    >
      {/* Source tabs */}
      <div className="flex gap-1 mb-3 border-b border-neutral-200 dark:border-neutral-700">
        <button
          className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
            source === 'en'
              ? 'border-blue-500 text-blue-600 dark:text-blue-400'
              : 'border-transparent text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300'
          }`}
          onClick={() => setSource('en')}
        >
          {t(`${prefix}.templateEnTab`)}
        </button>
        <button
          className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
            source === 'zh'
              ? 'border-blue-500 text-blue-600 dark:text-blue-400'
              : 'border-transparent text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300'
          }`}
          onClick={() => setSource('zh')}
        >
          {t(`${prefix}.templateZhTab`)}
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-2 mb-3">
        <select
          value={division}
          onChange={(e) => setDivision(e.target.value)}
          className="px-3 py-1.5 text-sm rounded-lg border border-neutral-300 bg-white dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
        >
          <option value="">{t(`${prefix}.templateAllDivisions`)}</option>
          {divisions.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input
            className="w-full pl-8 pr-3 py-1.5 text-sm rounded-lg border border-neutral-300 bg-white dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            placeholder={t(`${prefix}.templateSearchPlaceholder`)}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Main content: list + preview */}
      <div className="flex gap-4" style={{ minHeight: '420px' }}>
        {/* Template list */}
        <div className="w-1/2 overflow-y-auto rounded-lg border border-neutral-200 dark:border-neutral-700">
          {loading ? (
            <div className="flex items-center justify-center h-full py-12">
              <Spinner />
            </div>
          ) : templates.length === 0 ? (
            <div className="flex items-center justify-center h-full py-12 text-sm text-neutral-400">
              {t(`${prefix}.templateNoResults`)}
            </div>
          ) : (
            templates.map((tpl) => (
              <div
                key={tpl.id}
                onClick={() => handleSelect(tpl)}
                className={`flex items-start gap-3 px-3 py-2.5 cursor-pointer border-b border-neutral-100 dark:border-neutral-800 last:border-b-0 transition-colors ${
                  selectedId === tpl.id
                    ? 'bg-blue-50 dark:bg-blue-950/30'
                    : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/50'
                }`}
              >
                <span className="text-lg shrink-0 mt-0.5">{tpl.emoji || '🤖'}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-neutral-900 dark:text-neutral-100 truncate">
                    {tpl.name}
                  </div>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5 line-clamp-2">
                    {tpl.description}
                  </div>
                  <span className="inline-block mt-1 text-[10px] px-1.5 py-0.5 rounded-full bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400">
                    {tpl.division}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Preview panel */}
        <div className="w-1/2 overflow-y-auto rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
          {!selectedId && (
            <div className="flex items-center justify-center h-full text-sm text-neutral-400">
              {t(`${prefix}.templatePreview`)}
            </div>
          )}
          {selectedId && previewLoading && (
            <div className="flex items-center justify-center h-full">
              <Spinner />
            </div>
          )}
          {selectedId && !previewLoading && previewContent !== null && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-xl">{selectedTemplate?.emoji || '🤖'}</span>
                <div>
                  <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                    {previewName}
                  </h3>
                  {previewDesc && (
                    <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                      {previewDesc}
                    </p>
                  )}
                </div>
              </div>
              <textarea
                readOnly
                value={previewContent}
                rows={18}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 resize-none focus:outline-none"
              />
            </div>
          )}
          {selectedId && !previewLoading && previewContent === null && (
            <div className="flex items-center justify-center h-full text-sm text-red-500">
              {t(`${prefix}.templateContentLoadError`)}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
