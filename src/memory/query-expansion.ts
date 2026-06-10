/**
 * Query expansion — preprocesses user queries for FTS5 search.
 *
 * Tokenizes, removes stopwords (Chinese + English), deduplicates, and builds
 * FTS5-compatible query strings. Pure functions, no side effects, no I/O.
 */

// ─── Stopword lists ──────────────────────────────────────────────────────────

const CHINESE_STOPWORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着',
  '没有', '看', '自己', '这', '他', '她', '它', '们', '那', '些', '什么',
  '哪', '吗', '呢', '吧', '啊', '哦', '嗯', '哈', '可以', '能', '应该',
  '需要', '可能', '也许', '大概', '好像', '感觉', '觉得', '知道', '因为',
  '所以', '但是', '不过', '虽然', '如果', '的话', '而且', '或者', '然后',
  '之后', '之前', '时候', '怎么', '怎么样', '为什么', '干嘛', '多少',
  '那个', '这个', '哪个', '一下', '一点', '一些', '还', '再', '又', '已经',
  '正在', '一直', '总是', '经常', '比较', '非常', '特别', '太', '对',
  '从', '把', '被', '让', '用', '以', '为', '跟', '与', '关于', '对于',
]);

const ENGLISH_STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall',
  'should', 'can', 'could', 'may', 'might', 'must', 'i', 'me', 'my',
  'we', 'us', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her',
  'it', 'its', 'they', 'them', 'their', 'this', 'that', 'these', 'those',
  'what', 'which', 'who', 'whom', 'where', 'when', 'why', 'how', 'not',
  'no', 'nor', 'and', 'but', 'or', 'if', 'then', 'else', 'at', 'in',
  'on', 'to', 'for', 'of', 'with', 'by', 'from', 'up', 'about', 'into',
  'through', 'during', 'before', 'after', 'above', 'below', 'between',
  'under', 'again', 'further', 'then', 'once', 'here', 'there', 'all',
  'each', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'only',
  'own', 'same', 'so', 'than', 'too', 'very', 'just', 'because', 'as',
  'until', 'while', 'please', 'help', 'thing', 'stuff', 'really',
  'actually', 'basically', 'literally', 'yesterday', 'today', 'now',
]);

// ─── CJK detection ───────────────────────────────────────────────────────────

function isCJK(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  return (
    (cp >= 0x4E00 && cp <= 0x9FFF) || // CJK Unified
    (cp >= 0x3400 && cp <= 0x4DBF) || // CJK Extension A
    (cp >= 0xF900 && cp <= 0xFAFF)    // CJK Compatibility
  );
}

// ─── Tokenization ────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  for (const ch of text) {
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current.toLowerCase());
        current = '';
      }
    } else if (isCJK(ch)) {
      if (current) {
        tokens.push(current.toLowerCase());
        current = '';
      }
      tokens.push(ch); // CJK character is its own token
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current.toLowerCase());
  return tokens;
}

// ─── Validation helpers ──────────────────────────────────────────────────────

function isValidToken(token: string): boolean {
  if (token.length === 0) return false;
  // Pure CJK character(s) — always valid
  if ([...token].every(isCJK)) return true;
  // Pure ASCII letters — must be >= 3 chars
  if (/^[a-z]+$/.test(token)) return token.length >= 3;
  // Pure digits — skip
  if (/^\d+$/.test(token)) return false;
  // Pure punctuation — skip
  if (/^[^\w\s]+$/.test(token)) return false;
  // Mixed (e.g., "v2", "3d") — keep if has letters
  return /[a-z]/i.test(token);
}

function isStopWord(token: string): boolean {
  return CHINESE_STOPWORDS.has(token) || ENGLISH_STOPWORDS.has(token);
}

// ─── FTS5 query building ─────────────────────────────────────────────────────

/**
 * Check if a token needs to be quoted in an FTS5 query.
 */
export function needsQuoting(token: string): boolean {
  return (
    /["*()]/.test(token) ||
    /\s/.test(token) ||
    /^(AND|OR|NOT|NEAR)$/i.test(token)
  );
}

/**
 * Escape a raw string for use as an FTS5 literal query (double-quoted).
 */
export function escapeFtsQuery(raw: string): string {
  return `"${raw.replace(/"/g, '""')}"`;
}

// ─── Public interface ────────────────────────────────────────────────────────

export interface ExpandedQuery {
  ftsQuery: string; // FTS5-compatible query string
  originalTokens: string[]; // All tokens after tokenization
  filteredTokens: string[]; // Tokens after stopword removal and dedup
}

/**
 * Preprocess a raw user query: tokenize, filter stopwords, dedup, build FTS5 query.
 * If all tokens are filtered out, the ftsQuery falls back to the escaped raw query.
 */
export function expandQuery(rawQuery: string): ExpandedQuery {
  const trimmed = rawQuery.trim();
  if (!trimmed) {
    return { ftsQuery: '', originalTokens: [], filteredTokens: [] };
  }

  const originalTokens = tokenize(trimmed);
  const filtered = originalTokens.filter(t => !isStopWord(t) && isValidToken(t));
  const unique = [...new Set(filtered)];

  const ftsTerms = unique.map(t => {
    if (needsQuoting(t)) return `"${t.replace(/"/g, '""')}"`;
    if (/^[a-z]{2,3}$/.test(t)) return `${t}*`;
    return t;
  });

  const ftsQuery =
    ftsTerms.length > 0 ? ftsTerms.join(' ') : escapeFtsQuery(trimmed);

  return { ftsQuery, originalTokens, filteredTokens: unique };
}
