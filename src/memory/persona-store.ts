import { MemoryRepository } from './repositories/memory-repository.js';
import {
  type UserPersona,
  createEmptyPersona,
  personaToJson,
  personaFromJson,
} from './persona-model.js';

const PERSONA_ID = '__persona__';
const PERSONA_SCOPE = 'user';
const PERSONA_SCOPE_KEY = '__persona__';
const PERSONA_KIND = 'persona';
const LATEST_PREFERENCE_LIMIT = 5;

function timestampMs(value: string | undefined): number {
  if (!value) return 0;
  // Handle epoch millisecond numeric strings produced by the DB default:
  //   cast(strftime('%s','now') as integer) * 1000
  // Date.parse rejects pure numeric strings in modern Node, so convert directly.
  if (/^\d+$/.test(value)) {
    const ms = Number(value);
    return Number.isFinite(ms) ? ms : 0;
  }
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : 0;
}

function memoryChangedMs(memory: { created_at: string; updated_at: string }): number {
  return Math.max(timestampMs(memory.created_at), timestampMs(memory.updated_at));
}

function stripPreferredNameClauses(text: string): string {
  return text
    .replace(/用户希望被称呼为[^。；;]+[。；;]?/g, '')
    .replace(/[，,；;]?\s*(?:偏好)?被称呼为[""��]?[^""。，,；;]+[""��]?[。，,；;]?/g, '')
    .replace(/[，,；;]?\s*(?:偏好)?称呼(?:用户)?为[""��]?[^""。，,；;]+[""��]?[。，,；;]?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanName(name: string): string {
  return name
    .replace(/^[''""「」『』]+/, '')
    .replace(/[''""「」『』]+$/, '')
    .trim();
}

/**
 * Extract preferred name from memory content.
 * Handles: "称呼偏好是X", "被称呼为X", "称呼为X", "称呼我X",
 *          "call me X", with or without quotes and optional whitespace
 *          between the verb and the name.
 */
function extractPreferredName(content: string): string | null {
  const Q = /[""'']?/; // optional quote: ", ", ', '
  const N = /([^"'""''\s，,;。.]{1,24})/; // name capture (no quotes, whitespace, CJK punctuation)

  const patterns: RegExp[] = [
    /(?:称呼|称谓)偏好(?:是|为|[:：])?\s*[""'']*([^"'""''\s，,;。.]{1,24})/,
    /(?:我|用户)(?:希望|想|要|偏好|喜欢)被称呼为\s*[""'']*([^"'""''\s，,;。.]{1,12})/,
    /(?:我|用户)(?:希望|想|要|偏好|喜欢)?称呼为\s*[""'']*([^"'""''\s，,;。.]{1,12})/,
    /(?:以后)?(?:称呼|叫|喊)(?:我|用户|其)(?:为|成|作)?\s*[""'']*([^"'""''\s，,;。.]{1,12})/,
    /(?:call\s+me|call\s+the\s+user)\s*[""'']*([^"'""''\s，,;。.]{1,12})/i,
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    const raw = match?.[1]?.trim();
    if (!raw) continue;
    const name = cleanName(raw);
    if (name && !['我', '用户', '自己'].includes(name)) return name;
  }
  return null;
}

/**
 * PersonaStore manages user persona persistence and context injection.
 *
 * Stores serialised UserPersona objects in the memories table via
 * MemoryRepository, using a fixed record id ('__persona__') so that
 * every save() is an upsert — there is never more than one row.
 *
 * Storage layout in the memories table:
 *   id         = '__persona__'
 *   scope      = 'user'
 *   scope_key  = '__persona__'
 *   kind       = 'persona'
 *   content    = JSON.stringify(persona)
 *   visibility = 'shared'
 *   agent_id   = null
 */
export class PersonaStore {
  constructor(private readonly memoryRepo: MemoryRepository) {}

  /**
   * Read the latest persona from the memories table.
   * Returns `null` when no persona has been saved yet.
   */
  get(): UserPersona | null {
    const records = this.memoryRepo.findByScopeAndKind(
      PERSONA_SCOPE,
      PERSONA_SCOPE_KEY,
      PERSONA_KIND,
    );
    if (records.length === 0) return null;

    // Sort by updated_at descending to pick the most recent record.
    // (With the fixed-id upsert there should only ever be one row, but
    //  defensive sorting costs nothing.)
    records.sort(
      (a: { updated_at: string }, b: { updated_at: string }) =>
        timestampMs(b.updated_at) - timestampMs(a.updated_at),
    );

    return personaFromJson(records[0].content);
  }

  /**
   * Persist (upsert) a persona to the memories table.
   * Automatically refreshes `lastUpdated` before writing.
   */
  save(persona: UserPersona, options?: { updateLastUpdated?: boolean }): void {
    if (options?.updateLastUpdated !== false) {
      persona.lastUpdated = new Date().toISOString();
    }
    const content = personaToJson(persona);

    this.memoryRepo.upsert({
      id: PERSONA_ID,
      scope: PERSONA_SCOPE,
      scope_key: PERSONA_SCOPE_KEY,
      kind: PERSONA_KIND,
      content,
    });
  }

  /**
   * Apply deterministic high-priority preference updates that should not wait
   * for LLM distillation. Returns true when the persona was updated.
   */
  applyFastPreference(content: string): boolean {
    const preferredName = extractPreferredName(content);
    if (!preferredName) return false;

    const existing = this.get();
    const persona = existing ?? createEmptyPersona();
    if (!existing) {
      persona.lastUpdated = new Date(0).toISOString();
    }

    // Extract old preferred name from communication field to replace
    // inline references in the summary (e.g. "用户大D" → "用户三弟")
    const oldNameMatch = persona.preferences.communication.match(/称呼用户为([^；;]+)/);
    const oldName = oldNameMatch?.[1]?.trim();

    const summaryPrefix = `用户希望被称呼为${preferredName}。`;
    let summary = stripPreferredNameClauses(persona.summary);
    if (oldName && oldName.length >= 2 && oldName !== preferredName) {
      // Replace inline old name references that the clause stripper missed
      // (e.g. "用户大D" embedded in text, "名为大D", "（大D）")
      summary = summary
        .replace(new RegExp(`用户${escapeRegExp(oldName)}`, 'g'), `用户${preferredName}`)
        .replace(new RegExp(`名为${escapeRegExp(oldName)}`, 'g'), `名为${preferredName}`)
        .replace(new RegExp(`称呼${escapeRegExp(oldName)}`, 'g'), `称呼${preferredName}`)
        .replace(new RegExp(`(?:（|\\()${escapeRegExp(oldName)}(?:）|\\))`, 'g'), `（${preferredName}）`);
    }
    persona.summary = summary
      ? `${summaryPrefix}${summary}`
      : summaryPrefix;

    const communication = stripPreferredNameClauses(persona.preferences.communication);
    persona.preferences.communication = `称呼用户为${preferredName}；${communication || '回复直接、准确、简洁。'}`;
    this.save(persona, { updateLastUpdated: false });
    return true;
  }

  /**
   * Format the current persona as a concise Chinese text snippet suitable
   * for LLM context injection.  Returns a message under 500 characters.
   */
  toContextString(): string {
    const persona = this.get();
    const latestPreferences = this.getPreferencesNewerThan(persona?.lastUpdated)
      .slice(0, LATEST_PREFERENCE_LIMIT);

    if (!persona && latestPreferences.length === 0) return '';

    const hasAnyData =
      persona && (
        persona.summary ||
        persona.preferences.tools.length > 0 ||
        persona.preferences.languages.length > 0 ||
        persona.preferences.workflows.length > 0 ||
        persona.preferences.communication ||
        persona.skills.known.length > 0 ||
        persona.skills.learning.length > 0 ||
        persona.context.device ||
        persona.context.environment
      );

    if (!hasAnyData && latestPreferences.length === 0) return '';

    const lines: string[] = ['[当前用户画像 — 称呼以这里为准，忽略对话历史中的旧称呼]'];

    if (latestPreferences.length > 0) {
      lines.push('[最新用户偏好，优先于用户画像]');
      for (const pref of latestPreferences) {
        lines.push(`- ${pref.content}`);
      }
    }

    if (persona?.summary) {
      lines.push(persona.summary);
    }

    // Preferences: tools & languages on one line
    const prefParts: string[] = [];
    if (persona?.preferences.tools.length) {
      prefParts.push(`常用工具: ${persona.preferences.tools.join(', ')}`);
    }
    if (persona?.preferences.languages.length) {
      prefParts.push(`语言: ${persona.preferences.languages.join(', ')}`);
    }
    if (prefParts.length > 0) {
      lines.push(prefParts.join(' — '));
    }

    // Workflows
    if (persona?.preferences.workflows.length) {
      lines.push(`工作流: ${persona.preferences.workflows.join('，')}`);
    }

    if (persona?.preferences.communication) {
      lines.push(`沟通: ${persona.preferences.communication}`);
    }

    // Skills: known & learning on one line
    const skillParts: string[] = [];
    if (persona?.skills.known.length) {
      skillParts.push(persona.skills.known.join(', '));
    }
    if (persona?.skills.learning.length) {
      skillParts.push(`学习: ${persona.skills.learning.join(', ')}`);
    }
    if (skillParts.length > 0) {
      lines.push(`技能: ${skillParts.join(' — ')}`);
    }

    // Context: device & environment
    const ctxParts: string[] = [];
    if (persona?.context.device) {
      ctxParts.push(`设备: ${persona.context.device}`);
    }
    if (persona?.context.environment) {
      ctxParts.push(`环境: ${persona.context.environment}`);
    }
    if (ctxParts.length > 0) {
      lines.push(ctxParts.join(' | '));
    }

    const result = lines.join('\n');
    return result.length > 500 ? result.slice(0, 497) + '...' : result;
  }

  /**
   * Check whether a persona record exists in storage.
   */
  exists(): boolean {
    return this.get() !== null;
  }

  private getPreferencesNewerThan(since?: string) {
    const sinceMs = timestampMs(since);
    return this.memoryRepo.findByScopeKind(PERSONA_SCOPE, 'preference')
      .filter((memory) => memoryChangedMs(memory) > sinceMs)
      .sort((a, b) => memoryChangedMs(b) - memoryChangedMs(a));
  }
}
