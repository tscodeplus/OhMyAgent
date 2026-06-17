export interface Session {
  id: string;
  project_id: string;
  chat_id: string;
  title?: string;
  /** INTEGER ms (from SQLite Date.now()) or legacy TEXT timestamp. */
  created_at: number | string;
  /** INTEGER ms (from SQLite Date.now()) or legacy TEXT timestamp. */
  updated_at: number | string;
  metadata?: Record<string, unknown>;
}

export interface MessageImage {
  url: string;
  alt?: string;
}

export interface MessageFile {
  name: string;
  path: string;
  size?: number;
}

export interface Message {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  /** Chronological timeline of text and tool calls within this message.
   *  When present, the UI renders segments in order (interleaved text and
   *  tool cards) instead of rendering all text first then all tool calls
   *  at the bottom. Set on streaming messages and reconstructed by the API
   *  for persisted history from block-order metadata. */
  segments?: MessageSegment[];
  footer?: MessageFooter;
  created_at: number | string;
  /** Approval request data (shown as ApprovalCard in the message list). */
  approval?: MessageApproval;
  /** Images generated or referenced by the agent. */
  images?: MessageImage[];
  /** Files generated or referenced by the agent (download links). */
  files?: MessageFile[];
  /** Skill activated for this turn (e.g. "Researcher"). */
  skill_activated?: string;
}

export interface MediaSegmentItem {
  url: string;
  alt?: string;
  name?: string;
  type: 'image' | 'video' | 'file';
  size?: number;
}

export interface MessageSegment {
  type: 'text' | 'tool_call' | 'media';
  content?: string;
  toolCall?: ToolCall;
  media?: MediaSegmentItem;
}

export interface MessageApproval {
  approvalId: string;
  command: string;
  risk: 'low' | 'medium' | 'high';
  reason?: string;
  status: 'pending' | 'approved' | 'rejected';
  decision?: string;
  /** Set when auto-rejected by timeout/expiry (e.g. 'timeout', 'expired_before_recovery'). */
  timeoutReason?: string;
}

export interface MessageFooter {
  model?: string;
  agentName?: string;
  completed?: boolean;
  elapsed?: number;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  showUsage?: boolean;
  showCacheHitRate?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  output?: string;
  status: 'running' | 'success' | 'error';
}
