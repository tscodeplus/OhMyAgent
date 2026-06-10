/**
 * Translate cron/interval/oneshot expressions to human-readable natural language.
 * Supports both zh-CN and en locales.
 */

// Day-of-week names
const DOW_ZH = ['日', '一', '二', '三', '四', '五', '六'] as const;
const DOW_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

// Month names (1-indexed)
const MONTH_ZH = ['', '1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'] as const;
const MONTH_EN = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export type CronHumanResult = string | null;

/**
 * Convert a schedule expression string to human-readable natural language.
 */
export function cronToHuman(expression: string, locale: string = 'zh-CN'): CronHumanResult {
  const expr = expression.trim();
  if (!expr) return null;

  // "every Xm/h/d" patterns
  const everyMatch = expr.match(/^every\s+(\d+)\s*(m|h|d)$/i);
  if (everyMatch) return everyToHuman(parseInt(everyMatch[1]!), everyMatch[2]!.toLowerCase(), locale);

  // "at HH:MM" one-shot
  const atTimeMatch = expr.match(/^at\s+(\d{1,2}):(\d{2})$/i);
  if (atTimeMatch) return atTimeToHuman(parseInt(atTimeMatch[1]!), parseInt(atTimeMatch[2]!), locale);

  // "at ISO" one-shot
  const atIsoMatch = expr.match(/^at\s+(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?)/i);
  if (atIsoMatch) return isZh(locale) ? `${new Date(atIsoMatch[1]!).toLocaleString('zh-CN')}` : new Date(atIsoMatch[1]!).toLocaleString('en-US');

  // Bare duration: "30m", "2h", "1d" → oneshot after X
  const bareMatch = expr.match(/^(\d+)\s*(m|h|d)$/i);
  if (bareMatch) return bareToHuman(parseInt(bareMatch[1]!), bareMatch[2]!.toLowerCase(), locale);

  // ISO timestamp
  const isoMatch = expr.match(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/);
  if (isoMatch) return isZh(locale) ? new Date(expr).toLocaleString('zh-CN') : new Date(expr).toLocaleString('en-US');

  // Try 5-field cron expression
  const fields = expr.trim().split(/\s+/);
  if (fields.length === 5) {
    return cronFieldsToHuman(fields, locale);
  }

  // Unknown — return as-is
  return expr;
}

function isZh(locale: string): boolean {
  return locale.startsWith('zh');
}

function everyToHuman(value: number, unit: string, locale: string): string {
  const unitStr = isZh(locale)
    ? (unit === 'm' ? '分钟' : unit === 'h' ? '小时' : '天')
    : (unit === 'm' ? 'minutes' : unit === 'h' ? 'hours' : 'days');
  return isZh(locale) ? `每${value}${unitStr}` : `Every ${value} ${unitStr}`;
}

function bareToHuman(value: number, unit: string, locale: string): string {
  const unitStr = isZh(locale)
    ? (unit === 'm' ? '分钟' : unit === 'h' ? '小时' : '天')
    : (unit === 'm' ? 'minutes' : unit === 'h' ? 'hours' : 'days');
  return isZh(locale) ? `${value}${unitStr}后` : `After ${value} ${unitStr}`;
}

function atTimeToHuman(hour: number, minute: number, locale: string): string {
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return isZh(locale) ? `今天 ${time}（一次性）` : `Today at ${time} (one-shot)`;
}

function cronFieldsToHuman(fields: string[], locale: string): string | null {
  const [min, hour, dom, month, dow] = fields as [string, string, string, string, string];
  const zh = isZh(locale);

  // Helper: is wildcard
  const w = (f: string) => f === '*';

  // Every N minutes: */N * * * *
  if (min.startsWith('*/') && w(hour) && w(dom) && w(month) && w(dow)) {
    const n = parseInt(min.slice(2)!, 10);
    if (n > 0) return zh ? `每${n}分钟` : `Every ${n} minutes`;
  }

  // Every N hours: 0 */N * * * or M */N * * *
  if (hour.startsWith('*/') && w(dom) && w(month) && w(dow)) {
    const n = parseInt(hour.slice(2)!, 10);
    const minPart = w(min) || min === '0' ? '' : `:${min.padStart(2, '0')}`;
    if (n > 0) return zh ? `每${n}小时${minPart}` : `Every ${n} hours${minPart}`;
  }

  // Hourly at minute M: M * * * *
  if (!w(min) && w(hour) && w(dom) && w(month) && w(dow)) {
    return zh ? `每小时的第${min}分钟` : `At minute ${min} of every hour`;
  }

  // Daily at HH:MM: MM HH * * *
  if (!w(min) && !w(hour) && w(dom) && w(month) && w(dow)) {
    const time = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
    // Check for comma-separated hours
    if (hour.includes(',')) {
      const hours = hour.split(',').map(h => `${h.padStart(2, '0')}:${min.padStart(2, '0')}`);
      return zh ? `每天 ${hours.join('、')}` : `Daily at ${hours.join(', ')}`;
    }
    return zh ? `每天 ${time}` : `Daily at ${time}`;
  }

  // Weekdays at HH:MM: MM HH * * 1-5
  if (!w(min) && !w(hour) && w(dom) && w(month) && dow === '1-5') {
    const time = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
    return zh ? `工作日 ${time}` : `Weekdays at ${time}`;
  }

  // Specific days of week: MM HH * * DOW
  if (!w(min) && !w(hour) && w(dom) && w(month) && !w(dow)) {
    const time = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
    const days = parseDow(dow, locale);
    return zh ? `每周${days} ${time}` : `Every ${days} at ${time}`;
  }

  // Monthly on specific day: MM HH DOM * *
  if (!w(min) && !w(hour) && !w(dom) && w(month) && w(dow)) {
    const time = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
    return zh ? `每月${dom}日 ${time}` : `Monthly on day ${dom} at ${time}`;
  }

  // Specific date: MM HH DOM MON *
  if (!w(min) && !w(hour) && !w(dom) && !w(month) && w(dow)) {
    const time = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
    const monthName = zh ? MONTH_ZH[parseInt(month)] : MONTH_EN[parseInt(month)];
    return zh ? `${monthName}${dom}日 ${time}` : `${monthName} ${dom} at ${time}`;
  }

  // Fallback: describe the raw expression
  return null;
}

function parseDow(dow: string, locale: string): string {
  const zh = isZh(locale);
  const names = zh ? DOW_ZH : DOW_EN;

  // Comma-separated
  if (dow.includes(',')) {
    const days = dow.split(',').map(d => names[parseInt(d) % 7]);
    return days.join(zh ? '、' : ', ');
  }

  // Range
  if (dow.includes('-')) {
    const [start, end] = dow.split('-');
    return `${names[parseInt(start!) % 7]}${zh ? '至' : '-'}${names[parseInt(end!) % 7]}`;
  }

  // Single
  return names[parseInt(dow) % 7] ?? dow;
}
