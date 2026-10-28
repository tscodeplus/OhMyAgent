/**
 * Deterministic mention mining — entities from memory text, zero model calls.
 *
 * Why this exists: `graph-sync` only projects `memory_links`, and the memory
 * extractor links very few entities per turn (the reference dev database held
 * 30 memories and 4 links). Five of those memories talk about Excel and Power
 * Query; exactly one of them ever produced a link, so the graph showed `Power
 * Query` and nothing else. An entity therefore existed only if some link
 * happened to name it, and the rest of the conversation history stayed
 * invisible. This module extracts the missing half for free.
 *
 * The contract is "deterministic and cheap", not "accurate": a jieba/Title-Case
 * heuristic will over-extract, and `GraphSyncSummary`-style counts carry no
 * precision guarantee. Two properties are non-negotiable though, because later
 * graph passes rely on them:
 *
 *   - **Deterministic** — same content in, same mentions out, in the same order
 *     (confidence desc, then first-mention order). No `Date`, no randomness, no
 *     locale-dependent comparison.
 *   - **Idempotent-friendly** — names are canonicalised with the same
 *     `canonicalizeEntityName` the repository uses, so re-mining an unchanged
 *     memory re-states existing entities instead of splitting them.
 *
 * Neither a curated vocabulary nor a stop-word list may be the reason a test
 * passes: the vocabulary only raises confidence for genuinely high-value
 * technical nouns, and every entry is still reachable through the generic
 * Latin/CJK paths (`Excel` is extracted because it is a capitalised Latin token,
 * not because it is listed).
 */

import { cutCJK, ZH_STOP_WORDS } from '../memory/fts-tokenizer.js';
import { canonicalizeEntityName } from '../memory/repositories/entity-repository.js';

export interface MineableMemory {
  id: string;
  content: string;
  /**
   * Row-shape parity with `memories` so a selected row can be passed straight
   * through. Extraction is content-only on purpose: deriving mentions from
   * `kind`/`scope` would make the same sentence mine differently depending on
   * where it was stored.
   */
  kind?: string;
  scope?: string;
  created_at?: string | number | null;
}

/** Which collector produced a mention; callers may weight them differently. */
export type MentionSource = 'vocabulary' | 'latin' | 'cjk';

export interface MinedMention {
  name: string;
  /** How sure the heuristics are that this is a nameable entity, 0..1. */
  confidence: number;
  /**
   * Collector that found it. A curated-vocabulary hit is a known technical term
   * and survives corpus filtering even when it appears once; positional
   * heuristics do not earn that trust.
   */
  source: MentionSource;
}

export interface MineMentionOptions {
  /** Maximum mentions returned. Default 8. */
  maxMentions?: number;
  /** Mentions longer than this are dropped as segmentation fragments. Default 40. */
  maxNameLength?: number;
}

export const DEFAULT_MAX_MENTIONS_PER_MEMORY = 8;
export const DEFAULT_MAX_MENTION_NAME_LENGTH = 40;

/** One mention before dedupe/ordering; `index` is its offset in the cleaned text. */
interface Candidate extends MinedMention {
  index: number;
}

const CJK_RUN_RE = /\p{Script=Han}+/gu;
const LATIN_TOKEN_RE = /[\p{Script=Latin}][\p{Script=Latin}\p{N}._+#-]*/gu;
const LATIN_TITLE_WORD_RE = /^\p{Lu}[\p{L}\p{Nd}]*$/u;
const INNER_UPPERCASE_RE = /\p{Lu}/u;
const NON_LETTER_RE = /[^\p{L}]/u;

/** `飞书|文档` style compounds past this length are more likely two words. */
const MAX_CJK_COMPOUND_LENGTH = 6;
/** "Power Query Monitor" reads as a phrase; four Title Case words usually do not. */
const MAX_PHRASE_WORDS = 3;

/**
 * High-value technical nouns. Listing a term earns it a confidence boost and
 * survives segmentation that would split it (jieba cuts 知识图谱 into 知识|图谱
 * and 飞书 into 飞|书), but it is never the only way a term can be found.
 */
const CURATED_MENTIONS: readonly string[] = [
  'Excel',
  'Power Query',
  'Power BI',
  'Word',
  'Outlook',
  'Feishu',
  'Lark',
  'Telegram',
  'WeChat',
  'TypeScript',
  'JavaScript',
  'Python',
  'Node.js',
  'SQLite',
  'PostgreSQL',
  'Redis',
  'Docker',
  'GitHub',
  'Git',
  'Linux',
  'Windows',
  'macOS',
  'Termux',
  'Android',
  'Tauri',
  'Electron',
  'Ollama',
  'OpenAI',
  'Anthropic',
  'DeepSeek',
  'Claude',
  'ChatGPT',
  'Markdown',
  'JSON',
  'YAML',
  'SQL',
  'MCP',
  'API',
  'LLM',
  '知识图谱',
  '记忆系统',
  '向量检索',
  '飞书',
  '表格',
  '工作表',
];

/**
 * Function words plus the generic nouns that make every preference memory look
 * alike ("用户希望…", "the user wants…"). Kept separate from `ZH_STOP_WORDS`
 * because that set serves FTS recall, where dropping 文件/信息 would cost
 * recall, and here it would leave the graph full of entities nobody searches.
 * Nothing in `CURATED_MENTIONS` may also appear in a stop list, or the curated
 * match is filtered right back out.
 */
const CJK_GENERIC_WORDS = new Set([
  '用户',
  '希望',
  '要求',
  '需要',
  '可以',
  '应该',
  '是否',
  '不要',
  '没有',
  '什么',
  '怎么',
  '记录',
  '指定',
  '新建',
  '创建',
  '完成',
  '扫描',
  '查询',
  '获取',
  '使用',
  '回复',
  '告知',
  '判断',
  '无法',
  '打开',
  '显示',
  '提供',
  '支持',
  '包括',
  '通过',
  '进行',
  '当前',
  '现在',
  '今天',
  '昨天',
  '明天',
  '时间',
  '时候',
  '问题',
  '文件',
  '目录',
  '内容',
  '信息',
  '方式',
  '方法',
  '操作',
  '偏好',
  '简短',
  '回答',
  '已经',
  '还是',
  '就是',
  '不是',
  '然后',
  '所以',
  '因为',
  '但是',
  '而且',
  '如果',
  '以及',
  '或者',
  '一下',
  '这个',
  '那个',
  '我们',
  '你们',
  '他们',
  '它们',
  '代理',
  '助手',
  '所有',
  '部分',
  '相应',
  '具体',
  '整体',
  '接入',
  '基于',
  '相关',
  '用于',
  '属于',
  '包含',
  '存在',
  '开始',
  '结束',
  '处理',
  '生成',
  '运行',
  '加载',
  '保存',
  '删除',
  '修改',
  '添加',
  '设置',
  '查看',
  '统计',
  '输出',
  '输入',
  '选择',
  '确认',
  '尝试',
  '发现',
  '觉得',
  '认为',
  '知道',
  '了解',
  '学习',
  '工作',
  '表示',
  '明白',
  '记住',
  '每个',
  '可能',
  '以内',
  '简洁',
  '列表',
  '结果',
  '验证',
  '控制',
  '只作',
  '实现',
  '解决',
  '产生',
]);

/**
 * English function words, generic nouns and path/system segments. `tmp`,
 * `src` and `home` are here because path separators are turned into spaces
 * before tokenising — that is what keeps `D:\tmp\excel-mcp` contributing
 * `excel-mcp` instead of the whole path — at the price of those segments
 * surfacing as candidate words.
 */
const LATIN_STOP_WORDS = new Set([
  'a',
  'about',
  'after',
  'again',
  'against',
  'all',
  'also',
  'am',
  'an',
  'and',
  'any',
  'app',
  'apps',
  'are',
  'as',
  'at',
  'be',
  'been',
  'before',
  'being',
  'between',
  'bin',
  'both',
  'build',
  'but',
  'by',
  'can',
  'could',
  'data',
  'desktop',
  'did',
  'directory',
  'dist',
  'do',
  'does',
  'doing',
  'down',
  'downloads',
  'during',
  'each',
  'e.g',
  'etc',
  'even',
  'every',
  'few',
  'file',
  'files',
  'folder',
  'folders',
  'for',
  'from',
  'further',
  'get',
  'got',
  'had',
  'has',
  'have',
  'having',
  'he',
  'her',
  'here',
  'hers',
  'him',
  'his',
  'home',
  'how',
  'i.e',
  'if',
  'in',
  'index',
  'into',
  'is',
  'it',
  'its',
  'just',
  'lib',
  'like',
  'list',
  'main',
  'make',
  'made',
  'may',
  'me',
  'might',
  'more',
  'most',
  'much',
  'must',
  'my',
  'need',
  'needs',
  'no',
  'nor',
  'not',
  'now',
  'of',
  'off',
  'ok',
  'okay',
  'on',
  'once',
  'only',
  'onto',
  'opt',
  'or',
  'other',
  'our',
  'out',
  'over',
  'own',
  'page',
  'path',
  'paths',
  'per',
  'please',
  'root',
  'same',
  'she',
  'should',
  'since',
  'so',
  'some',
  'src',
  'such',
  'temp',
  'than',
  'thanks',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'tmp',
  'to',
  'too',
  'under',
  'until',
  'up',
  'upon',
  'us',
  'use',
  'used',
  'user',
  'users',
  'uses',
  'using',
  'usr',
  'value',
  'values',
  'var',
  'very',
  'via',
  'vs',
  'want',
  'wants',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'whom',
  'whose',
  'why',
  'will',
  'with',
  'within',
  'without',
  'would',
  'yes',
  'you',
  'your',
]);

/**
 * Drop markup, URLs and path separators before tokenising.
 *
 * Fenced code is removed whole: it is mostly syntax, and the identifiers inside
 * it usually also appear in the prose that introduces it. Inline code keeps its
 * content — an identifier like `excel-mcp` is exactly the kind of name worth
 * having. URLs and path separators go because a URL's segments and a Windows
 * path's segments are noise, while the last segment (a real name) survives
 * tokenising.
 */
function stripMarkup(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/<[^>\n]{1,200}>/g, ' ')
    .replace(/[{}[\]"|~^]/g, ' ')
    .replace(/[\\/]+/g, ' ');
}

function isLatinStopWord(word: string): boolean {
  return LATIN_STOP_WORDS.has(word.toLowerCase());
}

function isCjkStopWord(token: string): boolean {
  return ZH_STOP_WORDS.has(token) || CJK_GENERIC_WORDS.has(token);
}

function isWantedMention(name: string, maxNameLength: number): boolean {
  if (name.length < 2 || name.length > maxNameLength) return false;
  // Pure numbers, dates and punctuation runs are never entities.
  return /[\p{L}]/u.test(name);
}

/** Strip the punctuation a token can pick up from surrounding text. */
function trimToken(raw: string): string {
  return raw.replace(/^[._+#-]+/, '').replace(/[._+#-]+$/, '');
}

function latinConfidence(word: string): number {
  // Internal capitals or identifier punctuation ("TypeScript", "excel-mcp",
  // "file_info.xlsx") announce a name rather than a word.
  if (INNER_UPPERCASE_RE.test(word.slice(1)) || NON_LETTER_RE.test(word)) return 0.8;
  if (/^\p{Lu}+$/u.test(word) && word.length <= 6) return 0.8; // acronym: API, MCP
  if (/^\p{Lu}/u.test(word)) return 0.7; // sentence-initial or proper noun
  return 0.5; // plain lowercase word: weak, but ordered last
}

function cjkConfidence(token: string): number {
  if (token.length >= 4) return 0.75;
  if (token.length === 3) return 0.7;
  return 0.6;
}

/** A Latin word that can extend or start a multi-word name. */
function isTitleWord(word: string): boolean {
  return LATIN_TITLE_WORD_RE.test(word);
}

/**
 * Curated vocabulary, matched on the raw (cleaned) text so segmentation cannot
 * break a term up. The original spelling is kept for display; the boundary check
 * stops `Word` from being mined out of `WordPress` and `Git` out of `GitHub`.
 */
function collectCurated(text: string, out: Candidate[]): void {
  const lower = text.toLowerCase();
  for (const term of CURATED_MENTIONS) {
    const needle = term.toLowerCase();
    let at = lower.indexOf(needle);
    while (at >= 0 && !hasWordBoundary(lower, at, needle.length)) {
      at = lower.indexOf(needle, at + 1);
    }
    if (at < 0) continue;
    out.push({
      name: text.slice(at, at + term.length),
      confidence: 0.9,
      source: 'vocabulary',
      index: at,
    });
  }
}

function hasWordBoundary(lower: string, at: number, length: number): boolean {
  const before = at === 0 ? '' : lower[at - 1]!;
  const after = at + length >= lower.length ? '' : lower[at + length]!;
  return !isLatinWordChar(before) && !isLatinWordChar(after);
}

function isLatinWordChar(char: string): boolean {
  // `-` and `_` count as word characters so a curated term is never mined out
  // of a longer identifier (`mcp` out of `excel-mcp`). `.` deliberately does
  // not: it usually ends a sentence, and counting it would hide `Node.js` at
  // the end of one.
  return char !== '' && /[\p{Script=Latin}\p{Nd}_-]/u.test(char);
}

/**
 * Latin mentions: adjacent Title Case words form one name ("Power Query"), and
 * every other token stands alone. Constituents of a phrase are absorbed, because
 * `Power` and `Query` on their own would otherwise eat two of the eight slots
 * with less specific versions of the same entity.
 */
function collectLatin(text: string, out: Candidate[]): void {
  const words: Array<{ word: string; index: number }> = [];
  for (const match of text.matchAll(LATIN_TOKEN_RE)) {
    const word = trimToken(match[0]);
    if (word) words.push({ word, index: match.index ?? 0 });
  }

  const absorbed = new Set<number>();
  for (let start = 0; start < words.length; start++) {
    // A word already consumed by a longer phrase cannot start a shorter one:
    // "Power Query Monitor" must not also yield "Query Monitor".
    if (absorbed.has(start)) continue;
    const first = words[start]!;
    if (!isTitleWord(first.word) || isLatinStopWord(first.word)) continue;

    let phrase = first.word;
    let end = start;
    while (end + 1 < words.length && end - start + 1 < MAX_PHRASE_WORDS) {
      const next = words[end + 1]!;
      if (!isTitleWord(next.word) || isLatinStopWord(next.word)) break;
      // Only genuinely adjacent words form a phrase: "Power, Query" is a list.
      const gap = text.slice(words[end]!.index + words[end]!.word.length, next.index);
      if (gap.trim() !== '' || gap.length > 1) break;
      phrase = `${phrase} ${next.word}`;
      end++;
    }

    if (end === start) continue;
    out.push({ name: phrase, confidence: 0.85, source: 'latin', index: first.index });
    for (let index = start; index <= end; index++) absorbed.add(index);
  }

  for (let index = 0; index < words.length; index++) {
    if (absorbed.has(index)) continue;
    const { word } = words[index]!;
    if (isLatinStopWord(word)) continue;
    out.push({
      name: word,
      confidence: latinConfidence(word),
      source: 'latin',
      index: words[index]!.index,
    });
  }
}

/**
 * CJK mentions via jieba, plus adjacent 2-char compounds.
 *
 * jieba segments 知识图谱 as 知识|图谱 and 飞书 as 飞|书, so two adjacent
 * content tokens are also emitted as one compound and both parts are absorbed:
 * a graph node called 知识图谱 is what a user searches for, while 知识 and 图谱
 * alone are fragments of it. Overlapping compounds are kept (记忆系统 and
 * 系统设计 are both plausible), which is the price of not having a tagger.
 *
 * Without jieba there is no word boundary information at all: only a short run
 * (a plausible compound on its own) is kept, and long runs are dropped rather
 * than sliced by guesswork.
 */
function collectCJK(text: string, out: Candidate[]): void {
  for (const match of text.matchAll(CJK_RUN_RE)) {
    const run = match[0];
    const runStart = match.index ?? 0;
    const tokens = cutCJK(run);

    if (tokens.length === 0) {
      if (run.length <= MAX_CJK_COMPOUND_LENGTH && !isCjkStopWord(run)) {
        out.push({ name: run, confidence: 0.75, source: 'cjk', index: runStart });
      }
      continue;
    }

    const parts: Array<{ token: string; index: number; absorbed: boolean }> = [];
    let cursor = 0;
    for (const token of tokens) {
      const at = run.indexOf(token, cursor);
      const start = at >= 0 ? at : cursor;
      cursor = start + token.length;
      parts.push({ token, index: runStart + start, absorbed: false });
    }

    for (let start = 0; start + 1 < parts.length; start++) {
      const left = parts[start]!;
      const right = parts[start + 1]!;
      if (left.token.length < 2 || right.token.length < 2) continue;
      if (isCjkStopWord(left.token) || isCjkStopWord(right.token)) continue;
      const compound = left.token + right.token;
      if (compound.length > MAX_CJK_COMPOUND_LENGTH) continue;
      out.push({ name: compound, confidence: 0.75, source: 'cjk', index: left.index });
      left.absorbed = true;
      right.absorbed = true;
    }

    for (const part of parts) {
      if (part.absorbed) continue;
      if (part.token.length < 2) continue;
      if (isCjkStopWord(part.token)) continue;
      if (!/\p{Script=Han}/u.test(part.token)) continue;
      out.push({
        name: part.token,
        confidence: cjkConfidence(part.token),
        source: 'cjk',
        index: part.index,
      });
    }
  }
}

/**
 * Extract the entities a memory mentions, most confident first.
 *
 * @returns At most `maxMentions` names, deduped case-insensitively, ordered by
 * confidence then first mention. Empty for blank/emoji/number-only content.
 */
export function mineMentionedEntities(
  memory: MineableMemory,
  options: MineMentionOptions = {},
): MinedMention[] {
  const maxMentions = Math.max(
    1,
    Math.floor(options.maxMentions ?? DEFAULT_MAX_MENTIONS_PER_MEMORY),
  );
  const maxNameLength = Math.max(
    2,
    Math.floor(options.maxNameLength ?? DEFAULT_MAX_MENTION_NAME_LENGTH),
  );

  const content = typeof memory?.content === 'string' ? memory.content : '';
  if (!content.trim()) return [];

  const text = stripMarkup(content);
  const candidates: Candidate[] = [];
  collectCurated(text, candidates);
  collectLatin(text, candidates);
  collectCJK(text, candidates);

  // Dedupe on the repository's canonical form so "Excel"/"excel" cannot become
  // two nodes; keep the most confident spelling, earliest mention on a tie.
  const best = new Map<string, Candidate>();
  for (const candidate of candidates) {
    if (!isWantedMention(candidate.name, maxNameLength)) continue;
    const key = canonicalizeEntityName(candidate.name);
    if (!key) continue;
    const current = best.get(key);
    if (
      !current ||
      candidate.confidence > current.confidence ||
      (candidate.confidence === current.confidence && candidate.index < current.index)
    ) {
      best.set(key, candidate);
    }
  }

  return [...best.values()]
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        left.index - right.index ||
        (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
    )
    .slice(0, maxMentions)
    .map(({ name, confidence, source }) => ({ name, confidence, source }));
}
