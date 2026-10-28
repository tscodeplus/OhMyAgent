/**
 * Deterministic mention mining — the subject producer for `memory_links`.
 *
 * Why this exists: the memory extractor links very few entities per turn (the
 * reference dev database held 30 memories and 4 links), and a `memory_links`
 * row it writes carries no subject — its `relation_type` is a document-level
 * keyword hint that applies to every entity found in the same text, so the row
 * says "this text contains a founding keyword and names Acme", never "X founded
 * Acme". The graph projection therefore had to invent a subject (highest
 * confidence, or a `memory:<id>` placeholder node when there was only one
 * link); measured on the real database, 9 of 22 nodes were those placeholders
 * and the one surviving predicate edge was almost certainly false.
 *
 * This module is the writer that removes the guess. For a memory it mines the
 * mentions deterministically, takes the most confident one as the memory's
 * subject, and records it — with both entity types — on every `memory_links`
 * row of that memory, inserting a `MENTIONED` row for each remaining mention.
 * The projection then *reads* the subject instead of re-deriving it, and since
 * a `MENTIONED` row is co-occurrence rather than a statement it never becomes
 * an `entity_edges` edge (see `graph-sync.ts`). `memory_links` stays what the
 * plan calls it: a weak "memory × mentioned entity" association that serves
 * recall, not the graph.
 *
 * The contract is "deterministic and cheap", not "accurate": a jieba/Title-Case
 * heuristic will over-extract, and the returned counts carry no precision
 * guarantee. Two properties are non-negotiable though, because the projection
 * relies on them:
 *
 *   - **Deterministic** — same content in, same mentions out, in the same order
 *     (confidence desc, then first-mention order). No `Date`, no randomness, no
 *     locale-dependent comparison.
 *   - **Idempotent-friendly** — names are canonicalised with the same
 *     `canonicalizeEntityName` the projection uses, and inserted rows carry a
 *     deterministic id, so re-mining an unchanged memory refreshes instead of
 *     duplicating.
 *
 * Neither a curated vocabulary nor a stop-word list may be the reason a test
 * passes: the vocabulary only raises confidence for genuinely high-value
 * technical nouns, and every entry is still reachable through the generic
 * Latin/CJK paths (`Excel` is extracted because it is a capitalised Latin token,
 * not because it is listed).
 */

import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
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

/**
 * Memories one mining call works through when the caller does not say.
 *
 * The `graph_sync` job always passes its configured `max_links_per_run`, so
 * this is only the standalone default. It is spelled here rather than imported
 * from `graph-config.ts` because that module imports `entity-mining.ts` for
 * `DEFAULT_MAX_MENTIONS_PER_MEMORY` — importing it back would make the two
 * modules cyclic and could evaluate `DEFAULT_GRAPH_SYNC_CONFIG` before this
 * constant exists.
 */
const DEFAULT_MINED_MEMORIES_PER_RUN = 500;

/**
 * The only relation deterministic mining can assert.
 *
 * A mined mention carries no verb, so inventing one would put a claim in the
 * database that nothing supports. `MENTIONED` says exactly what the text
 * proves — this memory talks about this name — and the projection keeps such
 * rows out of `entity_edges` for that reason.
 */
export const MENTION_RELATION_TYPE = 'MENTIONED';

/**
 * A name announces itself as an organization through its suffix. Nothing else
 * is decidable by shape.
 *
 * There is deliberately no `person` rule. The previous heuristic
 * (`/^[A-Z][a-z]+(?: [A-Z][a-z]+){1,2}$/`) typed "Power Query" as a person — a
 * measured defect in the plan §3.4 — and a wrong type splits one real entity
 * into two rows under `UNIQUE(canonical_name, entity_type)`. `person` may only
 * be asserted by a producer that actually knows (the LLM entity extractor's
 * `type` field, an SPO triplet); deterministic mining leaves it at `concept`.
 */
const ORGANIZATION_NAME_RE =
  /(公司|集团|大学|学院|研究院|研究所|实验室|医院|Inc\.?|Corp\.?|Ltd\.?|LLC|GmbH|S\.A\.)$/i;

/** Entity type to record for a mined name. See `ORGANIZATION_NAME_RE`. */
export function inferEntityType(name: string): string {
  return ORGANIZATION_NAME_RE.test(name.trim()) ? 'organization' : 'concept';
}

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

// ─── Subject producer: memory_links rows ────────────────────────────

export interface MemoryLinkMiningOptions {
  /** Max memories mined by this call. Default 500. */
  limit?: number;
  /** Max mentions taken from one memory. Default 8. */
  maxMentionsPerMemory?: number;
  /**
   * A mined name must appear in at least this many memories of the batch to
   * become a target, unless the graph already knows it or it came from the
   * curated vocabulary. Default 2 — see `buildMentionFilter` for why one
   * occurrence is not enough.
   */
  minDocumentFrequency?: number;
  /** Run the whole pass, then roll it back — nothing is written. */
  dryRun?: boolean;
  /** Cooperative cancellation between memories (scheduler timeout). */
  signal?: AbortSignal;
  /** Optional sink for per-row diagnostics; silent when absent. */
  logger?: Logger;
}

export interface MemoryLinkMiningSummary {
  /** Memories that gained a subject on at least one link (or a new link). */
  memoriesMined: number;
  /** Mentions accepted from those memories, the subject included. */
  mentionsMined: number;
  /** `memory_links` rows inserted for mentions other than the subject. */
  linksCreated: number;
  /** Rows written by another producer that gained their three subject columns. */
  linksAnnotated: number;
  /** Memories with nothing minable, or nothing to associate. */
  skipped: number;
}

interface MinableMemoryRow {
  memory_id: string;
  content: string;
  memory_kind: string | null;
  memory_scope: string | null;
}

interface ExistingLinkRow {
  link_id: string;
  target_entity: string;
}

/**
 * Sentinel thrown inside the dry-run transaction: better-sqlite3 rolls back on
 * throw and offers no other way to abort a transaction, so the rollback *is*
 * the dry run.
 */
const DRY_RUN_ROLLBACK = Symbol('entity-mining dry-run');

/**
 * Memories no producer has given a subject yet, newest first.
 *
 * The cursor is the subject itself: a memory leaves this batch as soon as one
 * of its link rows has `subject_entity` set. That leaves two kinds of memory
 * behind — one whose only minable mention is its own subject (there is nothing
 * to associate it with) and one whose mentions were all filtered out as
 * fragments. Neither has anything to record, so neither has a row that could
 * move it out of the batch; they are re-examined until the `limit` window
 * pushes them out.
 *
 * Newest first is what makes that eviction work: an old memory that records
 * nothing keeps its slot only until `limit` newer memories exist, so a backlog
 * of them can never crowd out a memory that does have a subject to record.
 * Oldest first would let such a backlog occupy every slot of every run forever.
 */
const MINABLE_MEMORY_SQL = `
SELECT m.id AS memory_id,
       m.content AS content,
       m.kind AS memory_kind,
       m.scope AS memory_scope
FROM memories m
WHERE m.status = 'active'
  AND trim(m.content) <> ''
  -- Two kinds are stored for bookkeeping, not as conversation content, and both
  -- mine as pure noise: the persona row is a distilled JSON profile (its keys and
  -- values read like entity names), and scene rows hold a path pointer
  -- ("scenes/<session>_<date>.md") whose fragments — the directory name, a uuid,
  -- two dates — are the worst offenders in the whole corpus.
  AND m.kind NOT IN ('persona', 'scene')
  AND NOT EXISTS (
    SELECT 1
    FROM memory_links ml
    WHERE ml.source_memory_id = m.id
      AND ml.subject_entity IS NOT NULL
  )
ORDER BY m.created_at DESC, m.id DESC
LIMIT @memoryLimit
`;

function readMinableMemories(db: Database.Database, limit: number): MinableMemoryRow[] {
  return db.prepare(MINABLE_MEMORY_SQL).all({ memoryLimit: limit }) as MinableMemoryRow[];
}

/** Mention must occur in at least this many of the batch's memories. */
const DEFAULT_MIN_DOCUMENT_FREQUENCY = 2;

function optionMinDocumentFrequency(options: MemoryLinkMiningOptions): number {
  const value = Number(options.minDocumentFrequency ?? DEFAULT_MIN_DOCUMENT_FREQUENCY);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_MIN_DOCUMENT_FREQUENCY;
}

/**
 * Record a subject on the `memory_links` rows of every memory that lacks one.
 *
 * For each memory the most confident mined mention becomes the subject; its
 * name and type are written on the memory's existing rows (whose subject a
 * keyword-only extractor cannot know), and each remaining mention is inserted
 * as its own `MENTIONED` row. Writes `memory_links` only — never
 * `entities`/`entity_edges`: co-occurrence is not a statement, and the graph
 * keeps only what a producer asserted (`syncGraphFromMemoryLinks`).
 *
 * Safe to call repeatedly: the batch excludes memories that already carry a
 * subject, existing rows keep the subject they were given first, and inserted
 * rows use a deterministic id. Throws only when the database itself is
 * unusable — every per-memory problem is counted in `skipped`.
 */
export function mineMemoryLinkSubjects(
  db: Database.Database,
  options: MemoryLinkMiningOptions = {},
): MemoryLinkMiningSummary {
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_MINED_MEMORIES_PER_RUN));
  const maxMentionsPerMemory = Math.max(
    1,
    Math.floor(options.maxMentionsPerMemory ?? DEFAULT_MAX_MENTIONS_PER_MEMORY),
  );
  const dryRun = options.dryRun === true;
  const { logger, signal } = options;

  const summary: MemoryLinkMiningSummary = {
    memoriesMined: 0,
    mentionsMined: 0,
    linksCreated: 0,
    linksAnnotated: 0,
    skipped: 0,
  };

  const mine = db.transaction(() => {
    const batch = readMinableMemories(db, limit);
    if (batch.length === 0) return;

    const extracted = batch.map((memory) => ({
      memory,
      mentions: mineMentionedEntities(
        {
          id: memory.memory_id,
          content: memory.content,
          kind: memory.memory_kind ?? undefined,
          scope: memory.memory_scope ?? undefined,
        },
        { maxMentions: maxMentionsPerMemory },
      ),
    }));

    // Two passes over the batch instead of one: extraction per memory, then a
    // corpus-level filter before anything is written.
    //
    // Per-memory extraction alone cannot tell a topic from a sentence fragment —
    // "Excel" and "问过" look equally plausible in isolation, and jieba happily
    // emits verbs. Across the batch the difference is stark: a real topic recurs
    // ("Excel" in 5 memories), a fragment is a one-off. So a name mentioned in a
    // single memory is dropped unless the graph already knows it (an existing
    // entity or alias) or it was found in the curated vocabulary.
    //
    // Cheap, deterministic and explainable — no model call and no per-name
    // judgement to disagree with later.
    const requestedMinDf = optionMinDocumentFrequency(options);
    const effectiveMinDf = batch.length >= requestedMinDf * 2 ? requestedMinDf : 1;
    const mentionFilter = buildMentionFilter(db, extracted, effectiveMinDf);

    const selectExisting = db.prepare(
      'SELECT id AS link_id, target_entity FROM memory_links WHERE source_memory_id = ?',
    );
    const annotate = db.prepare(
      `UPDATE memory_links
       SET subject_entity = @subject,
           subject_entity_type = @subjectType,
           target_entity_type = @targetType
       WHERE id = @id`,
    );
    const insert = db.prepare(
      `INSERT OR IGNORE INTO memory_links (
         id, source_memory_id, target_entity, relation_type, confidence,
         subject_entity, subject_entity_type, target_entity_type
       ) VALUES (
         @id, @sourceMemoryId, @targetEntity, @relationType, @confidence,
         @subject, @subjectType, @targetType
       )`,
    );

    for (const { memory, mentions: rawMentions } of extracted) {
      if (signal?.aborted) break;

      const mentions = rawMentions.filter((mention) => mentionFilter(mention));
      if (mentions.length === 0) {
        summary.skipped++;
        logger?.debug(
          { memoryId: memory.memory_id },
          '[entity-mining] memory skipped (no minable mention)',
        );
        continue;
      }

      const subject = mentions[0]!;
      const subjectKey = canonicalizeEntityName(subject.name);
      if (!subjectKey) {
        summary.skipped++;
        continue;
      }
      // The subject is recorded, not inferred later: every row written or
      // annotated here says what the memory is about, so the projection never
      // has to pick a subject by confidence or invent a placeholder node.
      const subjectType = inferEntityType(subject.name);

      try {
        const existing = selectExisting.all(memory.memory_id) as ExistingLinkRow[];
        const linkedKeys = new Set<string>();
        for (const row of existing) {
          const targetKey = canonicalizeEntityName(row.target_entity);
          if (targetKey) linkedKeys.add(targetKey);
          // The subject's own row states no relation to anything; leaving it
          // NULL keeps "subject unknown" truthful for a row that carries no fact.
          if (targetKey === subjectKey) continue;
          const result = annotate.run({
            id: row.link_id,
            subject: subject.name,
            subjectType,
            targetType: inferEntityType(row.target_entity),
          });
          summary.linksAnnotated += result.changes;
        }

        for (const mention of mentions) {
          const targetKey = canonicalizeEntityName(mention.name);
          if (!targetKey || targetKey === subjectKey || linkedKeys.has(targetKey)) continue;
          const result = insert.run({
            // Deterministic id: re-mining the same memory must not stack a second
            // row for the same name even if the earlier row was deleted by hand.
            id: `${memory.memory_id}:${targetKey}`,
            sourceMemoryId: memory.memory_id,
            targetEntity: mention.name,
            relationType: MENTION_RELATION_TYPE,
            confidence: Math.min(subject.confidence, mention.confidence),
            subject: subject.name,
            subjectType,
            targetType: inferEntityType(mention.name),
          });
          if (result.changes > 0) {
            summary.linksCreated += result.changes;
            linkedKeys.add(targetKey);
          }
        }

        summary.memoriesMined++;
        summary.mentionsMined += mentions.length;
      } catch (err) {
        // One malformed memory must not abort the run; it stays unmined and the
        // next pass retries it.
        summary.skipped++;
        logger?.warn(
          { memoryId: memory.memory_id, err: err instanceof Error ? err.message : String(err) },
          '[entity-mining] memory skipped',
        );
      }
    }

    if (dryRun) throw DRY_RUN_ROLLBACK;
  });

  try {
    mine();
  } catch (err) {
    if (err !== DRY_RUN_ROLLBACK) throw err;
  }

  return summary;
}

/**
 * Predicate that decides whether a mined mention survives the corpus filter.
 *
 * Kept as a closure over the counts so the write loop stays a plain loop, and
 * so the reason a mention was dropped is visible in one place:
 *   - seen in >= minDocumentFrequency memories of this batch, or
 *   - already an entity/alias (the graph learned it earlier — dropping it now
 *     would make the graph oscillate between runs), or
 *   - identified by the curated vocabulary rather than position heuristics.
 */
function buildMentionFilter(
  db: Database.Database,
  extracted: Array<{ memory: { memory_id: string }; mentions: MinedMention[] }>,
  minDocumentFrequency: number,
): (mention: MinedMention) => boolean {
  const counts = new Map<string, number>();
  for (const { mentions } of extracted) {
    const seenHere = new Set<string>();
    for (const mention of mentions) {
      const key = canonicalizeEntityName(mention.name);
      if (!key || seenHere.has(key)) continue;
      seenHere.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const known = new Set<string>();
  for (const row of db.prepare('SELECT canonical_name FROM entities').all() as Array<{
    canonical_name: string;
  }>) {
    known.add(row.canonical_name);
  }
  const aliasColumn = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'entity_aliases'")
    .get()
    ? (db.prepare('PRAGMA table_info(entity_aliases)').all() as Array<{ name: string }>).some(
        (column) => column.name === 'alias',
      )
    : false;
  if (aliasColumn) {
    for (const row of db.prepare('SELECT alias FROM entity_aliases').all() as Array<{
      alias: string;
    }>) {
      const key = canonicalizeEntityName(row.alias);
      if (key) known.add(key);
    }
  }

  return (mention: MinedMention): boolean => {
    const key = canonicalizeEntityName(mention.name);
    if (!key) return false;
    if (known.has(key)) return true;
    if (mention.source === 'vocabulary') return true;
    return (counts.get(key) ?? 0) >= minDocumentFrequency;
  };
}
