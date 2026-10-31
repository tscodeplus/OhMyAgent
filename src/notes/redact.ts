/**
 * Redaction before distillation (plan §5.2).
 *
 * Tool output and pasted logs are where credentials live, and a note is a
 * *permanent* copy — one leaked API key in a note is worse than the same key in a
 * transcript, because notes are exported, shared and re-read for years.
 *
 * Two layers, both cheap:
 *   - known credential shapes (`sk-…`, `ghp_…`, `AKIA…`, `Bearer …`, PEM blocks,
 *     `password=…`)
 *   - a heuristic for long high-entropy tokens (a bare base64 secret with no
 *     recognisable prefix)
 *
 * The placeholder keeps the *length*, not the value: `«redacted:32»` tells the
 * reviewer "something was hidden here" and gives no oracle to attack. Counts go
 * into `capture_runs.error` as `redacted:N` — never the matched text.
 */

export interface RedactResult {
  text: string;
  /** How many spans were replaced. The WebUI shows a warning when > 0. */
  count: number;
}

interface Rule {
  pattern: RegExp;
  /** Keeps the prefix so the note still reads sensibly (`sk-«redacted»`). */
  prefix?: string;
}

const RULES: Rule[] = [
  // Provider keys with recognisable prefixes.
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/g, prefix: 'sk-' },
  { pattern: /\bghp_[A-Za-z0-9]{20,}/g, prefix: 'ghp_' },
  { pattern: /\bgh[osur]_[A-Za-z0-9]{20,}/g, prefix: 'gh' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { pattern: /\bAIza[0-9A-Za-z_-]{20,}/g },
  // Authorization headers and assorted bearer tokens.
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, prefix: 'Bearer ' },
  // Key/value forms: password=..., api_key: ..., token="..."
  {
    pattern:
      /\b(password|passwd|secret|api[_-]?key|access[_-]?token|private[_-]?key)\b\s*[=:]\s*("[^"]{4,}"|'[^']{4,}'|[^\s,;]{4,})/gi,
  },
  // PEM private keys, including the body.
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  // JWT: three dot-separated base64url segments, the first of which is `eyJ`.
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // Feishu/Telegram-style bot tokens: digits:base64ish
  { pattern: /\b\d{6,}:[A-Za-z0-9_-]{30,}/g },
  // A long unbroken base64-ish run: the no-prefix fallback.
  { pattern: /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/=]{40,}(?![A-Za-z0-9+/=])/g },
];

function placeholderFor(span: string, prefix?: string): string {
  const size = span.length;
  return prefix ? `${prefix}«redacted:${size}»` : `«redacted:${size}»`;
}

/** Replace every credential-shaped span. Idempotent: a placeholder never re-matches. */
export function redactSecrets(input: string): RedactResult {
  let text = input;
  let count = 0;

  for (const rule of RULES) {
    text = text.replace(rule.pattern, (match) => {
      // Keep a `password=«redacted»` shape: the key name is the useful part, the
      // value is the secret. Prefix rules replace the whole span with a prefix
      // hint; the key/value rule keeps the left-hand side.
      if (/^(password|passwd|secret|api[_-]?key|access[_-]?token|private[_-]?key)\b/i.test(match)) {
        count += 1;
        const [head] = match.split(/[=:]/);
        return `${head}=«redacted»`;
      }
      count += 1;
      return placeholderFor(match, rule.prefix);
    });
  }

  return { text, count };
}

/**
 * `capture_runs.error` marker for a redacted capture.
 *
 * The count is diagnostic ("this conversation was full of keys"), and the text
 * itself must never be recorded — that would put the secret in a second table.
 */
export function redactionMarker(count: number): string | null {
  return count > 0 ? `redacted:${count}` : null;
}
