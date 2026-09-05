// ---------------------------------------------------------------------------
// P4 — message intent → tool-subset conditional narrowing
// ---------------------------------------------------------------------------
//
// Static profiles define the capability boundary; tool-search handles surface
// size. This module adds the missing middle layer: for a single turn, narrow
// the profile-allowed surface to the tools relevant to the detected intent
// domain. Narrowing is intentionally conservative:
//
//   - Only rule/trigger matching (no LLM calls) — deterministic and cheap.
//   - A domain match NARROWS; no match keeps the full profile surface.
//   - Forced-core tools (tool_search bridges, IM interaction) always survive.
//   - Skipped entirely when a skill strict surface or explicitTools is active.

import { STRICT_FORCED_CORE_TOOLS } from '../policy/tool-visibility.js';

export type IntentDomain =
  'code' | 'web' | 'multimedia' | 'memory' | 'project-management' | 'bare-chat';

export interface IntentMatch {
  domain: IntentDomain;
}

/**
 * Tool-name prefixes / exact names relevant to each domain. Matching is
 * prefix-based on the tool name (covers underscore/hyphen variants and
 * channel-prefixed media senders like feishu_send_media).
 */
const DOMAIN_TOOL_PATTERNS: Record<Exclude<IntentDomain, 'bare-chat'>, string[]> = {
  code: ['file_', 'file-', 'glob', 'grep', 'shell', 'lsp', 'notebook'],
  web: ['web_', 'web-', 'download'],
  multimedia: ['image', 'video', 'speech', 'send_media', '_send_media'],
  memory: ['memory', 'session_summarize', 'summarize-session'],
  'project-management': ['task_', 'task-', 'todo', 'cron', 'brief'],
};

const DOMAIN_KEYWORDS: Record<Exclude<IntentDomain, 'bare-chat'>, RegExp[]> = {
  code: [
    /(?:跑|运行|执行).{0,6}(?:测试|命令|脚本)/,
    /(?:修复|修一下|debug|fix).{0,8}(?:bug|报错|错误)/,
    /\b(?:code|coding|refactor|compile|build|test|lint)\b/i,
    /(?:代码|编程|编译|重构|提交代码|git\s+(?:commit|push|pull))/,
  ],
  web: [
    /\b(?:search|google|look\s?up|browse)\b/i,
    /(?:搜索|搜一下|查一下|上网|网页|新闻|查资料|打开网站)/,
  ],
  multimedia: [
    /(?:画|生成|制作).{0,6}(?:图|图片|插画|海报)/,
    /(?:生成|生成一个|做).{0,4}(?:视频|语音|音频)/,
    /\b(?:image|video|speech|transcribe|text[- ]to[- ]speech)\b/i,
    /(?:转文字|语音识别|图片识别)/,
  ],
  memory: [
    /\b(?:remember|forget|recall)\b/i,
    /(?:记住|记一下|还记得|忘记(?:了|掉)?|查一下(?:我|之前)|记忆)/,
  ],
  'project-management': [
    /\b(?:todo|task|schedule|reminder)\b/i,
    /(?:待办|任务|清单|提醒我|日程|计划一下|建个任务)/,
  ],
};

/** Chitchat signals for bare-chat: greetings/social filler, no task verbs. */
const BARE_CHAT_PATTERNS: RegExp[] = [
  /^(?:你好|您好|嗨|哈喽|在吗|早|早安|晚安|午安|谢谢|多谢|感谢|辛苦|拜拜|再见)[!！~。.，,\s]*$/,
  /^(?:hi|hello|hey|yo|thanks|thank you|thx|bye|good\s?(?:morning|evening|night)|ok|okay|got it|nice|cool)[!！~.?\s]*$/i,
  /^(?:哈哈|嘿嘿|嘻嘻|lol|haha|😂|🤣|👍|🎉|❤️|:\)|:D)[!！~。.\s]*$/,
];

/**
 * Tools kept in EVERY narrowed surface (in addition to the domain whitelist):
 * progressive-disclosure bridges + IM interaction.
 */
const NARROWING_FORCED = STRICT_FORCED_CORE_TOOLS;

/**
 * Detect the intent domain of a user message.
 *
 * Returns undefined when no domain matches confidently — callers must treat
 * undefined as "no narrowing" (keep the full profile surface).
 */
export function detectIntentDomain(message: string): IntentMatch | undefined {
  const text = (message ?? '').trim();
  if (!text || text.length > 500) return undefined;

  for (const [domain, patterns] of Object.entries(DOMAIN_KEYWORDS) as [
    Exclude<IntentDomain, 'bare-chat'>,
    RegExp[],
  ][]) {
    if (patterns.some((p) => p.test(text))) {
      return { domain };
    }
  }

  // bare-chat: short social filler with no tool-ish signal at all. Require
  // the message to be short and match a chitchat pattern exactly.
  if (text.length <= 60 && BARE_CHAT_PATTERNS.some((p) => p.test(text))) {
    return { domain: 'bare-chat' };
  }

  return undefined;
}

/**
 * Return true when the tool should stay visible for the detected domain.
 *
 * bare-chat uses a fixed allowlist (memory + session + interaction); other
 * domains match by tool-name prefix patterns on top of the forced set.
 */
export function isToolVisibleForIntent(toolName: string, domain: IntentDomain): boolean {
  if (NARROWING_FORCED.has(toolName)) return true;

  if (domain === 'bare-chat') {
    return /^(?:memory|session_summarize|summarize-session|brief)/.test(toolName);
  }

  const patterns = DOMAIN_TOOL_PATTERNS[domain] ?? [];
  return patterns.some((p) => toolName.includes(p));
}
