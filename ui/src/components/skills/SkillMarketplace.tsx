import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, ExternalLink, Download, Check, Loader2, Package } from 'lucide-react';
import { apiRequest } from '../../utils/api';
import { useToast } from '../ui/Toast';
import Button from '../ui/Button';

// ── Types ────────────────────────────────────────────────────────────────────

interface MarketplaceSkill {
  id: string;
  name: string;
  description: string;
  package: string;
  source: 'skills.sh' | 'skillhub';
  installs: number;
  url: string;
  author?: string;
  version?: string;
}

interface SearchResult {
  query: string;
  source: string;
  results: MarketplaceSkill[];
}

interface InstallResult {
  success: boolean;
  skillId?: string;
  skillName?: string;
  error?: string;
}

interface SkillMarketplaceProps {
  /** Called after a successful install so the parent can refresh the skill list */
  onInstall?: () => void;
}

type SourceFilter = 'all' | 'skills.sh' | 'skillhub';

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatInstalls(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function getInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/[-_\s]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0] + parts[1]![0]).toUpperCase();
  return trimmed.slice(0, 2).toUpperCase();
}

// ── Source badge colors ──────────────────────────────────────────────────────

const sourceColors: Record<string, string> = {
  'skills.sh': 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  'skillhub': 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
};

// ── Component ────────────────────────────────────────────────────────────────

export default function SkillMarketplace({ onInstall }: SkillMarketplaceProps) {
  const { t } = useTranslation('common');
  const { showToast } = useToast();

  // Search state
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<SourceFilter>('all');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<MarketplaceSkill[]>([]);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState(false);

  // Popular / initial load — lazy, no loading indicator
  const [popular, setPopular] = useState<MarketplaceSkill[]>([]);
  const [popularLoaded, setPopularLoaded] = useState(false);

  // Selection & install
  const [selected, setSelected] = useState<MarketplaceSkill | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installedPkgs, setInstalledPkgs] = useState<Set<string>>(new Set());

  // ── Lazy-load popular skills (no spinner) ───────────────────────────────

  useEffect(() => {
    let cancelled = false;
    apiRequest<{ results: MarketplaceSkill[] }>('/api/marketplace/popular?limit=12')
      .then((data) => {
        if (!cancelled) {
          setPopular(data.results ?? []);
          setPopularLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setPopularLoaded(true);
      });
    return () => { cancelled = true; };
  }, []);

  // ── Search ──────────────────────────────────────────────────────────────

  const handleSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;

    setSearching(true);
    setSearched(true);
    setSearchError(false);
    setSelected(null);

    try {
      const params = new URLSearchParams({ q, source, limit: '30' });
      const data = await apiRequest<SearchResult>(`/api/marketplace/search?${params.toString()}`);
      setResults(data.results ?? []);
    } catch {
      setSearchError(true);
      showToast(t('marketplace.loadError'), 'error');
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [query, source, showToast, t]);

  // Search on Enter
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleSearch();
    },
    [handleSearch],
  );

  // ── Install ─────────────────────────────────────────────────────────────

  const handleInstall = useCallback(async () => {
    if (!selected) return;

    setInstalling(true);
    try {
      const result = await apiRequest<InstallResult>('/api/marketplace/install', {
        method: 'POST',
        body: JSON.stringify({ package: selected.package, source: selected.source }),
      });

      if (result.success) {
        setInstalledPkgs((prev) => new Set(prev).add(selected.package));
        showToast(t('marketplace.installSuccess', { name: result.skillName || selected.name }), 'success');
        // Notify parent so it can refresh the skill list
        onInstall?.();
      } else {
        showToast(result.error || t('marketplace.installError'), 'error');
      }
    } catch (err) {
      showToast((err as Error).message || t('marketplace.installError'), 'error');
    } finally {
      setInstalling(false);
    }
  }, [selected, showToast, t, onInstall]);

  // ── Display list ────────────────────────────────────────────────────────

  const displayList = searched ? results : (popularLoaded ? popular : []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Search bar */}
      <div className="shrink-0 border-b border-neutral-200 px-3 sm:px-6 py-2.5 dark:border-neutral-800">
        <div className="flex gap-2">
          {/* Source filter */}
          <select
            value={source}
            onChange={(e) => setSource(e.target.value as SourceFilter)}
            className="h-8 shrink-0 rounded-md border border-neutral-300 bg-white px-2.5 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 focus:outline-none focus:ring-2 focus:ring-violet-500/20"
          >
            <option value="all">{t('marketplace.sourceAll')}</option>
            <option value="skills.sh">{t('marketplace.sourceSkillsSh')}</option>
            <option value="skillhub">{t('marketplace.sourceSkillhub')}</option>
          </select>

          {/* Search input */}
          <div className="relative flex-1">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              className="w-full h-8 pl-7.5 pr-3 text-xs rounded-md border border-neutral-300 bg-white dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 focus:outline-none focus:ring-2 focus:ring-violet-500/20"
              placeholder={t('marketplace.searchPlaceholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
            />
          </div>

          <Button variant="primary" size="sm" onClick={handleSearch} loading={searching}>
            {t('common.search')}
          </Button>
        </div>
      </div>

      {/* Main content: list + detail */}
      <div className="flex min-h-0 flex-1">
        {/* Left: Skill list */}
        <div className="w-[42%] max-sm:w-full shrink-0 flex flex-col border-r border-neutral-200 dark:border-neutral-800">
          <div className="min-h-0 flex-1 overflow-y-auto">
            {searching ? (
              <div className="flex items-center justify-center gap-2 py-12 text-neutral-500 dark:text-neutral-400">
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
                <span className="text-xs">{t('marketplace.loading')}</span>
              </div>
            ) : displayList.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-12 text-neutral-400 dark:text-neutral-500">
                <Package className="h-8 w-8 opacity-50" strokeWidth={1.5} />
                <span className="text-xs">
                  {searched
                    ? (searchError ? t('marketplace.loadError') : t('marketplace.noResults'))
                    : t('marketplace.searchPlaceholder')}
                </span>
              </div>
            ) : (
              <div className="divide-y divide-neutral-100 dark:divide-neutral-800/50">
                {displayList.map((skill) => {
                  const isSelected = selected?.id === skill.id;
                  const isInstalled = installedPkgs.has(skill.package);

                  return (
                    <button
                      key={skill.id}
                      type="button"
                      onClick={() => setSelected(skill)}
                      className={`flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors ${
                        isSelected
                          ? 'bg-violet-50 dark:bg-violet-950/20'
                          : 'hover:bg-neutral-50 dark:hover:bg-neutral-900/50'
                      }`}
                    >
                      {/* Avatar */}
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-neutral-100 text-[10px] font-semibold text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                        {getInitials(skill.name)}
                      </div>

                      {/* Info */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-[13px] font-medium text-neutral-900 dark:text-neutral-100">
                            {skill.name}
                          </span>
                          {isInstalled && (
                            <Check className="h-3 w-3 shrink-0 text-green-500" strokeWidth={2.5} />
                          )}
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
                          {skill.description || skill.package}
                        </p>
                        <div className="mt-1.5 flex items-center gap-2">
                          <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${sourceColors[skill.source] || 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400'}`}>
                            {skill.source}
                          </span>
                          {skill.installs > 0 && (
                            <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                              {formatInstalls(skill.installs)} {t('marketplace.installs', { count: skill.installs })}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right: Detail panel */}
        <div className="flex min-h-0 flex-1 flex-col max-sm:hidden">
          {selected ? (
            <>
              {/* Info header */}
              <div className="shrink-0 border-b border-neutral-200 px-4 sm:px-6 py-3 dark:border-neutral-800">
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-sm font-bold text-violet-700 dark:bg-violet-900/30 dark:text-violet-400">
                    {getInitials(selected.name)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="text-[14px] font-semibold text-neutral-900 dark:text-neutral-100 truncate">
                      {selected.name}
                    </h2>
                    <p className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400 font-mono truncate">
                      {selected.package}
                    </p>
                  </div>
                </div>

                {/* Meta chips */}
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  <span className={`inline-block rounded px-2 py-0.5 text-[10px] font-medium ${sourceColors[selected.source] || ''}`}>
                    {selected.source}
                  </span>
                  {selected.author && (
                    <span className="inline-block rounded bg-neutral-100 px-2 py-0.5 text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                      {selected.author}
                    </span>
                  )}
                  {selected.version && (
                    <span className="inline-block rounded bg-neutral-100 px-2 py-0.5 text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                      v{selected.version}
                    </span>
                  )}
                  {selected.installs > 0 && (
                    <span className="inline-block rounded bg-neutral-100 px-2 py-0.5 text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                      {formatInstalls(selected.installs)} {t('marketplace.installs', { count: selected.installs })}
                    </span>
                  )}
                </div>
              </div>

              {/* Description */}
              <div className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-6 py-3">
                {selected.description ? (
                  <p className="text-[13px] leading-relaxed text-neutral-700 dark:text-neutral-300 whitespace-pre-wrap">
                    {selected.description}
                  </p>
                ) : (
                  <p className="text-[13px] text-neutral-400 dark:text-neutral-500 italic">
                    {t('marketplace.selectHint')}
                  </p>
                )}
              </div>

              {/* Actions footer */}
              <div className="flex shrink-0 items-center justify-between border-t border-neutral-200 px-4 sm:px-6 py-2.5 dark:border-neutral-800">
                <a
                  href={selected.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[12px] text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200 transition-colors"
                >
                  <ExternalLink className="h-3 w-3" strokeWidth={1.75} />
                  {t('marketplace.viewOnMarket')}
                </a>

                {installedPkgs.has(selected.package) ? (
                  <Button variant="secondary" size="sm" disabled>
                    <Check className="h-3.5 w-3.5" strokeWidth={2} />
                    {t('marketplace.installed')}
                  </Button>
                ) : (
                  <Button variant="primary" size="sm" onClick={handleInstall} loading={installing}>
                    <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
                    {t('marketplace.install')}
                  </Button>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-[13px] text-neutral-400 dark:text-neutral-500">
              {t('marketplace.selectHint')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
