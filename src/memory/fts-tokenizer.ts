/**
 * FTS5 Tokenizer — Chinese word segmentation via @node-rs/jieba.
 *
 * Inspired by TencentDB-Agent-Memory's buildFtsQuery() + tokenizeForFts().
 *
 * Design:
 * - `tokenizeForIndex(text)` — jieba cutForSearch, join with spaces.
 *   The result is stored in a standalone FTS5 content column so the
 *   unicode61 tokenizer treats each jieba token as a word.
 * - `buildQuery(text)` — jieba cutForSearch → deduplicate →
 *   OR-joined quoted FTS5 phrase terms. BM25 naturally ranks docs
 *   matching more tokens higher.
 * - Falls back to Unicode regex splitting when jieba is unavailable.
 */

import { createRequire } from 'node:module';

// ── Lazy jieba singleton ──

interface JiebaInstance {
  cutForSearch(text: string, hmm: boolean): string[];
}

let _jieba: JiebaInstance | null | undefined; // undefined = not yet tried

function getJieba(): JiebaInstance | null {
  if (_jieba !== undefined) return _jieba;
  try {
    // @node-rs/jieba is CJS, use createRequire for ESM compatibility
    const req = createRequire(import.meta.url);
    const { Jieba } = req('@node-rs/jieba');
    const { dict } = req('@node-rs/jieba/dict');
    _jieba = Jieba.withDict(dict) as JiebaInstance;
  } catch {
    _jieba = null;
  }
  return _jieba;
}

// ── Chinese stop-words ──

const ZH_STOP_WORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着',
  '没有', '看', '好', '自己', '这', '他', '她', '它', '们', '那',
  '吗', '吧', '呢', '啊', '呀', '哦', '嗯', '什么', '怎么', '为什么',
]);

// ── Public API ──

/**
 * Tokenize text for FTS5 indexing (write-side).
 *
 * Uses jieba `cutForSearch()` to segment Chinese text, then joins tokens
 * with spaces. The result is stored in the FTS5 content column so that
 * `unicode61` tokenizer can split each jieba token as a separate word.
 *
 * Falls back to the original text when jieba is unavailable.
 */
export function tokenizeForIndex(text: string): string {
  const jieba = getJieba();
  if (!jieba) return text;

  const tokens = jieba.cutForSearch(text, true)
    .filter(t => t.trim()); // drop whitespace-only tokens jieba emits for Latin scripts
  return tokens.join(' ');
}

/**
 * Build an FTS5 MATCH query string from raw user text.
 *
 * Uses jieba `cutForSearch()` for accurate Chinese word segmentation,
 * producing OR-joined quoted terms so a document matching any token is
 * returned. BM25 naturally ranks documents matching more tokens higher.
 *
 * Falls back to Unicode-regex splitting if jieba is unavailable.
 *
 * Example (with jieba):
 *   "用户喜欢编程和TypeScript" → '"用户" OR "喜欢" OR "编程" OR "TypeScript"'
 */
export function buildFtsQuery(raw: string): string | null {
  const jieba = getJieba();

  let tokens: string[];
  if (jieba) {
    tokens = jieba
      .cutForSearch(raw, true)
      .map((t) => t.trim())
      .filter((t) => {
        if (!t) return false;
        if (!/[\p{L}\p{N}]/u.test(t)) return false;
        if (ZH_STOP_WORDS.has(t)) return false;
        return true;
      });
    tokens = [...new Set(tokens)];
  } else {
    tokens =
      raw
        .match(/[\p{L}\p{N}_]+/gu)
        ?.map((t) => t.trim())
        .filter((t) => t.length >= 2) ?? [];
  }

  if (tokens.length === 0) return null;
  const escaped = tokens.map((t) => `"${t.replaceAll('"', '')}"`);
  return escaped.join(' OR ');
}

/**
 * Whether jieba is available for Chinese segmentation.
 */
export function isJiebaAvailable(): boolean {
  return getJieba() !== null;
}

// ── Test helpers ──

/** Reset jieba for testing. @internal */
export function _resetJiebaForTest(): void {
  _jieba = undefined;
}

/** Override jieba instance for testing. @internal */
export function _setJiebaForTest(instance: JiebaInstance | null): void {
  _jieba = instance;
}
