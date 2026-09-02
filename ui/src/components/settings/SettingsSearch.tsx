import { useState, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';
import { SEARCH_INDEX } from './search-index';

interface SettingsSearchProps {
  onSelect: (tabId: string, subTabId?: string) => void;
}

export default function SettingsSearch({ onSelect }: SettingsSearchProps) {
  const { t } = useTranslation('common');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    const seen = new Set<string>();
    return SEARCH_INDEX.filter((entry) => {
      const label = t(entry.labelKey).toLowerCase();
      return label.includes(q);
    })
      .filter((entry) => {
        const key = `${entry.tabId}:${entry.labelKey}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 8);
  }, [query, t]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2 py-1.5 dark:border-neutral-800 dark:bg-neutral-800">
        <Search size={14} className="shrink-0 text-neutral-400" />
        <input
          type="text"
          name="settings-search"
          autoComplete="off"
          data-form-type="other"
          data-lpignore="true"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => query.trim() && setOpen(true)}
          placeholder={t('settings.groups.searchPlaceholder')}
          className="w-32 bg-transparent text-sm text-neutral-900 placeholder-neutral-400 outline-none dark:text-neutral-100"
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setOpen(false);
            }}
            className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {open && results.length > 0 && (
        <div className="absolute right-0 z-50 mt-1 w-56 rounded-lg border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-800">
          {results.map((entry, i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                onSelect(entry.tabId, entry.subTabId);
                setQuery('');
                setOpen(false);
              }}
              className="w-full px-3 py-2 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-700"
            >
              {entry.contextKey && (
                <span className="text-xs text-neutral-500 dark:text-neutral-400 mr-1">
                  {t(entry.contextKey)} ›
                </span>
              )}
              <span className="text-neutral-700 dark:text-neutral-300">{t(entry.labelKey)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
