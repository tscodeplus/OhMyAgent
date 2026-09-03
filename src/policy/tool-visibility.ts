// ---------------------------------------------------------------------------
// v4 Policy — tool visibility policy
// ---------------------------------------------------------------------------

import type { ToolProfileId, AgentPolicyScope } from './types.js';

export const PROFILE_TOOLS: Record<ToolProfileId, string[]> = {
  // restricted: read-only + memory + basic session. No shell (structural write
  // boundary — tool absence beats policy patches), no file write, no network
  // write, no spawn/computer_use, no persisting members (cronjob/skill_create).
  restricted: [
    'file_read',
    'memory_recall',
    'memory-recall',
    'memory_store',
    'memory-store',
    'memory_list',
    'session_summarize',
    'summarize-session',
    'tool_search',
    'brief',
    'ask_user_question',
  ],
  standard: [
    'shell',
    'file_read',
    'file_write',
    'file-write',
    'file_edit',
    'file_search',
    'download_file',
    'download-file',
    'memory_recall',
    'memory-recall',
    'memory_store',
    'memory-store',
    'memory_list',
    'memory_delete',
    'memory_update',
    'session_summarize',
    'summarize-session',
    'web_fetch',
    'web-fetch',
    'web_search',
    'web-search',
    'image_to_text',
    'image_generation',
    'image-generation',
    'video_generation',
    'video-generation',
    'tool_search',
    'ask_user_question',
    'brief',
    'todo_write',
    'sleep',
    'config',
    'task_create',
    'task_get',
    'task_list',
    'send_message',
    'memory_audit_persona',
    'memory_doctor',
    'memory_compact',
    'speech_to_text',
    'feishu_send_media',
    'wechat_send_media',
    'qq_send_media',
    'telegram_send_media',
    'webui_send_media',
    'cronjob',
    'skill_create',
    'skill-create',
    'skill_lint',
    'skill-lint',
    'Skill',
  ],
  full: [], // empty = all tools visible
};

const PROFILE_RANK: Record<ToolProfileId, number> = {
  restricted: 0,
  standard: 1,
  full: 2,
};

/**
 * Skill-declared tool lists for a turn.
 *
 * Semantics (deny-first): `deniedTools` always removes a tool, even from a
 * wider profile; `allowedTools` grants a tool beyond the profile but never
 * narrows it — skill `allowed-tools` frontmatter is authored as "tools this
 * skill needs", not an exclusive whitelist.
 */
export interface SkillToolOverrides {
  allowedTools?: string[];
  deniedTools?: string[];
  /**
   * P1 strict mode: when true, the visible surface narrows to allowedTools ∪
   * STRICT_FORCED_CORE_TOOLS (deny-first still wins) — the profile baseline is
   * skipped entirely for this turn.
   */
  strict?: boolean;
}

/**
 * Tools always visible even in strict mode (IM interaction + progressive
 * disclosure bridges). Denied-tools still remove these.
 */
export const STRICT_FORCED_CORE_TOOLS: ReadonlySet<string> = new Set([
  'tool_search',
  'tool_describe',
  'tool_call',
  'ask_user_question',
  'send_message',
  'brief',
]);

export interface ToolVisibilityPolicy {
  /** Returns true if the named tool is visible under the given scope. */
  isVisible(
    toolName: string,
    scope: AgentPolicyScope,
    skillOverrides?: SkillToolOverrides,
  ): boolean;
}

export class ToolVisibilityPolicyImpl implements ToolVisibilityPolicy {
  isVisible(
    toolName: string,
    scope: AgentPolicyScope,
    skillOverrides?: SkillToolOverrides,
  ): boolean {
    // Explicit deny always wins
    if (skillOverrides?.deniedTools?.includes(toolName)) {
      return false;
    }

    // P1 strict mode: surface narrows to allowedTools ∪ forced core. The
    // profile baseline is skipped — the strict skill is the capability boundary
    // for this turn.
    if (skillOverrides?.strict) {
      return (
        (skillOverrides.allowedTools?.includes(toolName) ?? false) ||
        STRICT_FORCED_CORE_TOOLS.has(toolName)
      );
    }

    // Explicit allow overrides profile
    if (skillOverrides?.allowedTools?.includes(toolName)) {
      return true;
    }

    // computer_use gated by scope flag and runtime config, not by profile
    if (toolName === 'computer_use') {
      return scope.computerUseEnabled;
    }

    // 'full' profile sees everything
    if (scope.toolsProfile === 'full') {
      return true;
    }

    const visible = PROFILE_TOOLS[scope.toolsProfile];
    if (!visible) return false;

    return visible.includes(toolName);
  }

  /** Compare two profiles — returns the stricter one. */
  static minProfile(a: ToolProfileId, b: ToolProfileId): ToolProfileId {
    return PROFILE_RANK[a] <= PROFILE_RANK[b] ? a : b;
  }
}
