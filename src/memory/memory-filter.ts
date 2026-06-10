/**
 * Memory capture filter — determines if a message should be stored as memory.
 * Optimized for Chinese + English content.
 */

// Trigger patterns (Chinese + English)
const TRIGGER_PATTERNS = [
  // Chinese
  /记住|记一下|帮我记|不要忘|别忘|牢记|备忘|记录一下|记下来/,
  // English
  /\bremember\b|\bnote\s+(?:this|that)\b|\bkeep\s+(?:in\s+)?mind\b|\bdon'?t\s+forget\b/i,
];

// Prompt injection patterns
const INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+)?previous\s+(?:instructions|prompts)/i,
  /ignore\s+(?:above|prior)\s+(?:instructions|context)/i,
  /system\s*:\s*/i,
  /\[INST\]/i,
  /<<SYS>>/i,
  /you\s+are\s+now\s+(?:a|an)\s+/i,
  /forget\s+(?:all\s+)?(?:everything|instructions)/i,
  /新的?系统提示|忽略(之前|上面|以上)(的)?(指令|提示|要求)/,
  /扮演|假装是|你现在是/,
];

// HTML/Markdown heavy content
const HTML_PATTERN = /<[^>]+>/;
const MARKDOWN_HEAVY = /(?:^|\n)#{1,6}\s|(?:^|\n)[\*\-]\s|(?:^|\n)\d+\.\s|(?:^|\n)```/;

export interface FilterResult {
  capture: boolean;
  reason?: string;
  category?: MemoryCategory;
}

export type MemoryCategory = 'preference' | 'fact' | 'task' | 'device_state';

/**
 * Safety-only check — validates content size and checks for prompt injection.
 * Does NOT require trigger words. Use when the LLM has explicitly decided
 * to store a memory entry (e.g., via the memory-store tool).
 */
export function isSafe(text: string): FilterResult {
  if (text.length < 2) {
    return { capture: false, reason: 'too_short' };
  }
  if (text.length > 2000) {
    return { capture: false, reason: 'too_long' };
  }

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      return { capture: false, reason: 'injection_detected' };
    }
  }

  return { capture: true, category: detectCategory(text) };
}

/**
 * Determine if a message should be captured as memory.
 */
export function shouldCapture(text: string): FilterResult {
  // Length filter: 5-500 chars
  if (text.length < 5) {
    return { capture: false, reason: 'too_short' };
  }
  if (text.length > 500) {
    return { capture: false, reason: 'too_long' };
  }

  // HTML heavy content
  const htmlMatches = text.match(/<[^>]+>/g);
  if (HTML_PATTERN.test(text) && htmlMatches && htmlMatches.length > 3) {
    return { capture: false, reason: 'html_heavy' };
  }

  // Markdown heavy (likely code/docs, not conversational memory)
  if (MARKDOWN_HEAVY.test(text)) {
    return { capture: false, reason: 'markdown_heavy' };
  }

  // Prompt injection detection
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      return { capture: false, reason: 'injection_detected' };
    }
  }

  // Trigger word detection
  for (const pattern of TRIGGER_PATTERNS) {
    if (pattern.test(text)) {
      return { capture: true, category: detectCategory(text) };
    }
  }

  return { capture: false, reason: 'no_trigger' };
}

/**
 * Detect memory category from text content.
 */
export function detectCategory(text: string): MemoryCategory {
  // Preference indicators — check FIRST to prevent task patterns from capturing
  // 称呼/昵称/叫/喊 patterns (e.g. "称呼我Boss", "以后叫我老大")
  if (/称呼|昵称|称谓|叫我|喊我|叫我|叫我|称我|叫我|喊我|名字.*(?:叫|是)/i.test(text) ||
      /(?:你)?(?:以后|今后|将来|往后|接下来|下次)?(?:要)?(?:称呼|叫|喊|称)(?:我|用户|其)?(?:为|作|成)?\S/i.test(text) ||
      /(?:call|name)\s+(?:me|the user)/i.test(text)) {
    return 'preference';
  }

  // 偏好/喜欢/习惯
  if (/喜欢|偏好|习惯|讨厌|想要|希望.*(?:称呼|回复|回答|方式|风格)/i.test(text) ||
      /prefer|like|favorite|always\s+use|hate/i.test(text)) {
    return 'preference';
  }

  // 语言/沟通风格
  if (/(?:用|使用|说|讲|语言).*(?:中文|英文|日文|回复|回答)/i.test(text) ||
      /(?:简洁|详细|幽默|正式|随意).*(?:回复|回答|交流|沟通)/i.test(text) ||
      /(?:communicat|language|tone|style.*prefer|prefer.*style)/i.test(text)) {
    return 'preference';
  }

  // 工具偏好 (pnpm/npm/yarn 等)
  if (/(?:用|使用|喜欢|偏好|prefer).*(?:pnpm|npm|yarn|pip|brew|git|docker)/i.test(text)) {
    return 'preference';
  }

  // Task indicators — check BEFORE device_state to avoid "deploy the app" → device_state
  if (/需要|必须|应该|待办|todo|task|need\s+to|must|deploy|build|create|fix|update|完成|提交|部署|开发|修改|更新|修复/i.test(text)) {
    return 'task';
  }

  // Device state indicators
  if (/手机|设备|adb|安装|app|phone|device|install/i.test(text)) {
    return 'device_state';
  }

  // Default to fact
  return 'fact';
}
