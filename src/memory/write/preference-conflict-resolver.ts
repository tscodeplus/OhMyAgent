/**
 * PreferenceConflictResolver — determines the active winner among same-topic
 * preferences and marks losers as superseded.
 *
 * Topics:
 *   - preferred_name       → 称呼/昵称偏好
 *   - communication_style  → 沟通风格
 *   - tool_preference      → 工具喜好
 *   - language_preference  → 语言偏好
 *   - workflow_preference  → 工作流偏好
 *   - generic              → 通用（默认不自动 supersede）
 */

import type { MemoryRepository } from '../repositories/memory-repository.js';
import { matchesMemoryAccess } from '../memory-access-policy.js';

/** Parse a DB timestamp string (epoch ms or ISO) into a numeric value for comparison. */
function dbTimestampMs(value: string): number {
  if (!value) return 0;
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

export interface ConflictResolution {
  winnerId: string;
  supersededIds: string[];
  topic: string;
}

const TOPIC_PATTERNS: Record<string, RegExp[]> = {
  preferred_name: [
    /称呼|叫|喊|称|名字|昵称|称谓/,
    /\bcall\s+me\b|\bname\b.*\bprefer/i,
  ],
  communication_style: [
    /回复|回答|交流|沟通|说话|语气|风格|方式.*回复/,
    /\bresponse\b|\btone\b|\bstyle\b|\bcommunicat/i,
  ],
  tool_preference: [
    /工具|pnpm|npm|yarn|pip|brew|git|docker|k8s|kubectl/,
    /\btool\b|\bprefer\s+\w+\s+(?:over|instead)/i,
  ],
  language_preference: [
    /语言|中文|英文|日文|翻译|用.*回答/,
    /\blanguage\b|\bEnglish\b|\bChinese\b/i,
  ],
  workflow_preference: [
    /流程|工作流|步骤|方法|先.*再|顺序/,
    /\bworkflow\b|\bprocess\b|\bstep/i,
  ],
};

/** Detect the topic of a preference by matching content against topic patterns. */
export function detectTopic(content: string): string {
  for (const [topic, patterns] of Object.entries(TOPIC_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(content)) return topic;
    }
  }
  return 'generic';
}

export interface ResolverOptions {
  /** If true, skip resolution for 'generic' topic. Default true. */
  skipGeneric?: boolean;
}

export interface ResolveContext {
  scope: string;
  scopeKey: string;
  agentId?: string | null;
  visibility?: string;
}

export class PreferenceConflictResolver {
  constructor(
    private memoryRepo: MemoryRepository,
    private options: ResolverOptions = {},
  ) {}

  /**
   * Resolve conflicts for a new preference. Finds all active preferences
   * on the same topic and marks older/lower-confidence ones as superseded.
   */
  resolve(newId: string, content: string, context: ResolveContext): ConflictResolution {
    const topic = detectTopic(content);
    const supersededIds: string[] = [];

    if (topic === 'generic' && (this.options.skipGeneric !== false)) {
      return { winnerId: newId, supersededIds: [], topic };
    }

    const allPrefs = this.findConflictCandidates(context.scope, context.scopeKey, topic);
    const newConflictKey = conflictKey(topic, content);
    const sameTopic = allPrefs.filter(p => {
      if (p.id === newId) return false;
      if (p.status !== 'active') return false;
      if (detectTopic(p.content) !== topic) return false;
      if (conflictKey(topic, p.content) !== newConflictKey) return false;
      return matchesMemoryAccess(p, {
        scope: context.scope,
        scopeKey: this.isGlobalUserTopic(topic) ? undefined : context.scopeKey,
        agentId: context.agentId ?? undefined,
        includeShared: true,
      });
    });

    // Sort by updated_at descending — newest wins
    const newMemory = this.memoryRepo.findById(newId);
    if (!newMemory) return { winnerId: newId, supersededIds: [], topic };

    const candidates = [...sameTopic, newMemory].sort((a, b) => {
      const byUpdatedAt = dbTimestampMs(b.updated_at) - dbTimestampMs(a.updated_at);
      if (byUpdatedAt !== 0) return byUpdatedAt;
      if (a.id === newId) return -1;
      if (b.id === newId) return 1;
      return 0;
    });

    const winner = candidates[0];
    const losers = candidates.slice(1);

    for (const loser of losers) {
      if (loser.id === newId) continue; // Don't supersede the new one
      this.memoryRepo.supersede(loser.id, winner.id);
      supersededIds.push(loser.id);
    }

    // If the new memory isn't the winner, supersede it too
    if (winner.id !== newId) {
      this.memoryRepo.supersede(newId, winner.id);
      return { winnerId: winner.id, supersededIds: [...supersededIds, newId], topic };
    }

    return { winnerId: newId, supersededIds, topic };
  }

  /**
   * Detect the topic of a preference string.
   */
  getTopic(content: string): string {
    return detectTopic(content); // re-use centralized export
  }

  private findConflictCandidates(scope: string, scopeKey: string, topic: string) {
    if (this.isGlobalUserTopic(topic)) {
      return this.memoryRepo.findByScopeKind(scope, 'preference');
    }
    return this.memoryRepo.findByScopeAndKind(scope, scopeKey, 'preference');
  }

  private isGlobalUserTopic(topic: string): boolean {
    return topic === 'preferred_name' || topic === 'communication_style' || topic === 'language_preference';
  }
}

function conflictKey(topic: string, content: string): string {
  if (topic === 'preferred_name' || topic === 'communication_style' || topic === 'language_preference') {
    return topic;
  }
  if (topic === 'tool_preference') {
    const tools = content.match(/\b(pnpm|npm|yarn|pip|brew|git|docker|k8s|kubectl)\b/gi);
    return tools?.map(t => t.toLowerCase()).sort().join('|') || topic;
  }
  return topic;
}
