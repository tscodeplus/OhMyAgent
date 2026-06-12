// ---------------------------------------------------------------------------
// v4 Policy — tool visibility policy
// ---------------------------------------------------------------------------

import type { ToolProfileId, AgentPolicyScope } from './types.js';

export const PROFILE_TOOLS: Record<ToolProfileId, string[]> = {
  minimal: [
    'shell',
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
    'cronjob',
    'skill_create',
    'skill-create',
    'skill_lint',
    'skill-lint',
  ],
  standard: [
    'shell',
    'file_read',
    'file_write',
    'file-write',
    'file_edit',
    'file_search',
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
  advanced: [
    'shell',
    'file_read',
    'file_write',
    'file-write',
    'file_edit',
    'file_search',
    'glob',
    'grep',
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
    'remote_trigger',
    'remote-trigger',
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
    'spawn_agent',
    'task_create',
    'task_get',
    'task_list',
    'send_message',
    'task_stop',
    'task_output',
    'task_update',
    'enter_plan_mode',
    'exit_plan_mode',
    'enter_worktree',
    'exit_worktree',
    'team_create',
    'team_delete',
    'speech_to_text',
    'memory_audit_persona',
    'memory_rebuild_persona',
    'memory_doctor',
    'memory_compact',
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
  minimal: 0,
  standard: 1,
  advanced: 2,
  full: 3,
};

export interface ToolVisibilityPolicy {
  /** Returns true if the named tool is visible under the given scope. */
  isVisible(toolName: string, scope: AgentPolicyScope, skillOverrides?: { allowedTools?: string[]; deniedTools?: string[] }): boolean;
}

export class ToolVisibilityPolicyImpl implements ToolVisibilityPolicy {
  isVisible(
    toolName: string,
    scope: AgentPolicyScope,
    skillOverrides?: { allowedTools?: string[]; deniedTools?: string[] },
  ): boolean {
    // Explicit deny always wins
    if (skillOverrides?.deniedTools?.includes(toolName)) {
      return false;
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
