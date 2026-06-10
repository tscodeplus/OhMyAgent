import i18n from '../i18n/config';

export function cn(...classes: (string | undefined | false | null)[]): string {
  return classes.filter(Boolean).join(' ');
}

function t(key: string, opts?: Record<string, unknown>): string {
  try {
    const lang = i18n.language || 'zh-CN';
    const resources = (i18n as any).store?.data;
    if (resources?.[lang]?.common?.[key]) {
      let template = resources[lang].common[key] as string;
      if (opts) {
        for (const [k, v] of Object.entries(opts)) {
          template = template.replace(`{${k}}`, String(v));
        }
      }
      return template;
    }
  } catch {}
  // Hardcoded fallbacks for time format
  const fallbacks: Record<string, Record<string, string>> = {
    'zh-CN': { just_now: '刚刚', minutes_ago: '{count}分钟前', hours_ago: '{count}小时前', days_ago: '{count}天前' },
    'en': { just_now: 'just now', minutes_ago: '{count}m ago', hours_ago: '{count}h ago', days_ago: '{count}d ago' },
  };
  const lang = (i18n.language || 'zh-CN') as string;
  const fb = fallbacks[lang]?.[key] || key;
  if (opts) {
    let result = fb;
    for (const [k, v] of Object.entries(opts)) {
      result = result.replace(`{${k}}`, String(v));
    }
    return result;
  }
  return fb;
}

export function formatRelativeTime(raw: number | string): string {
  // Session timestamps are stored as INTEGER ms in SQLite → better-sqlite3
  // returns them as numbers. The function also accepts legacy TEXT timestamps
  // (ISO 8601 or SQLite datetime format) for migrated databases.
  const dateString = String(raw ?? '');
  if (!dateString) return t('just_now');

  let tsMs: number;

  // Integer milliseconds timestamp (13 digits, e.g. "1749398400000")
  // or integer seconds timestamp (10 digits, e.g. "1749398400")
  if (/^\d{10,13}$/.test(dateString)) {
    tsMs = parseInt(dateString, 10);
    if (tsMs < 1e12) tsMs *= 1000; // seconds → milliseconds
  } else if (dateString.includes('T')) {
    // ISO 8601: "2026-06-08T07:30:00.000Z"
    tsMs = new Date(dateString).getTime();
  } else {
    // SQLite datetime: "2026-06-08 07:30:00"
    tsMs = new Date(dateString.replace(' ', 'T') + 'Z').getTime();
  }

  // Defensive: if date parsing produced NaN, fall back to "just now"
  if (!isFinite(tsMs)) return t('just_now');

  const diffMs = Date.now() - tsMs;
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return t('just_now');
  if (diffMins < 60) return t('minutes_ago', { count: diffMins });
  if (diffHours < 24) return t('hours_ago', { count: diffHours });
  if (diffDays < 7) return t('days_ago', { count: diffDays });
  return new Date(tsMs).toLocaleDateString(i18n.language === 'zh-CN' ? 'zh-CN' : 'en');
}

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '...';
}

export function generateId(): string {
  return crypto.randomUUID();
}
