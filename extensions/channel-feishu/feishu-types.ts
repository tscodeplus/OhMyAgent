/**
 * Feishu-specific type definitions.
 */

// ─── Event Callback Payloads ───

/** Top-level event callback body from Feishu. */
export interface FeishuEventBody {
  /** Plain event JSON (may be absent when encrypted). */
  event?: Record<string, unknown>;
  /** AES-encrypted event JSON (hex or base64 encoded). */
  encrypt?: string;
  /** Verification token. */
  token?: string;
  /** SHA-256 signature for request verification. */
  signature?: string;
  /** Timestamp (seconds) used in signature computation. */
  timestamp?: string;
  /** Random nonce used in signature computation. */
  nonce?: string;
}

/** URL Verification challenge request. */
export interface FeishuChallengeBody {
  challenge: string;
  token: string;
  type: 'url_verification';
}

/** Decrypted event envelope wrapping the actual event. */
export interface FeishuEventEnvelope {
  schema?: string;
  header: {
    event_id: string;
    event_type: string;
    create_time: string;
    token: string;
    app_id: string;
    tenant_key: string;
  };
  event: Record<string, unknown>;
}

// ─── Message Events ───

/** im.message.receive_v1 event structure. */
export interface FeishuMessageReceiveEvent {
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    create_time: string;
    chat_id: string;
    chat_type: 'p2p' | 'group';
    message_type:
      | 'text'
      | 'post'
      | 'image'
      | 'audio'
      | 'media'
      | 'file'
      | 'sticker'
      | 'interactive'
      | 'share_chat'
      | 'share_user'
      | 'unknown';
    content: string;
    mentions?: FeishuMention[];
  };
  sender: {
    sender_id: {
      open_id: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type: 'user' | 'bot';
    tenant_key: string;
  };
}

/** Mention within a message. */
export interface FeishuMention {
  key: string;
  id: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  name: string;
  tenant_key?: string;
}

// ─── Card Action Callbacks ───

/** Card action callback body from Feishu. */
export interface FeishuCardActionCallback {
  operator: {
    open_id: string;
    user_id?: string;
    union_id?: string;
  };
  token: string;
  action: {
    tag: string;
    value: Record<string, unknown>;
    name?: string;
  };
  host: string;
  context: {
    open_message_id?: string;
    open_chat_id?: string;
    tenant_key?: string;
  };
}

// ─── Outbound: Send Message ───

/** Media resource extracted from a message. */
export interface ResourceDescriptor {
  type: 'image' | 'file' | 'audio' | 'video' | 'sticker';
  fileKey: string;
  fileName?: string;
  duration?: number;
  coverImageKey?: string;
}

/** Params for sending a message via Feishu API. */
export interface FeishuSendMessageParams {
  receive_id_type: 'open_id' | 'user_id' | 'union_id' | 'email' | 'chat_id';
  receive_id: string;
  msg_type: 'text' | 'interactive' | 'post' | 'image' | 'file' | 'audio' | 'media';
  content: string;
  uuid?: string;
}

// ─── Feishu API Responses ───

/** Standard Feishu API response envelope. */
export interface FeishuApiResponse<T = unknown> {
  code: number;
  msg: string;
  data: T;
}

/** Response from tenant access token endpoint. */
export interface FeishuTokenResponse {
  code: number;
  msg: string;
  tenant_access_token: string;
  expire: number;
}

/** Response data from tenant access token endpoint. */
export interface TenantAccessTokenData {
  tenant_access_token: string;
  expire: number;
}

/** Response data from message send endpoint. */
export interface SendMessageData {
  message_id: string;
  root_id?: string;
  parent_id?: string;
}

/** Response data from message update endpoint. */
export interface UpdateMessageData {
  message_id: string;
}

/** Response data from typing state endpoint. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TypingStateData {}

// ─── Approval Types ───

/** The four approval decisions. */
export type ApprovalDecision =
  | 'approve_once'
  | 'approve_always'
  | 'reject_once'
  | 'reject_always';

/** Persisted approval state for a request. */
export interface ApprovalPersistedState {
  requestId: string;
  decision: ApprovalDecision;
  decidedBy: string;
  decidedAt: string;
  policyScope?: 'global' | 'agent' | 'skill' | 'session';
}

/** In-memory pending approval request. */
export interface PendingApprovalRequest {
  requestId: string;
  sessionKey: string;
  chatId: string;
  threadId?: string;
  senderId: string;
  targetKind: 'tool' | 'shell';
  toolName?: string;
  command?: string;
  reason?: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';
  cardMessageId?: string;
  createdAt: string;
}

// ─── Card Builder Types ───

/** Approval card action button. */
export interface ApprovalCardButton {
  text: string;
  value: Record<string, unknown>;
  type: 'primary' | 'danger' | 'default';
}

/** Approval card data used for rendering. */
export interface ApprovalCardData {
  requestId: string;
  targetKind: 'tool' | 'shell';
  toolName?: string;
  command?: string;
  reason?: string;
  riskLevel: 'low' | 'medium' | 'high';
  sessionKey: string;
  chatId: string;
  threadId?: string;
  senderId: string;
}

// ─── Client Config ───

/** Configuration for FeishuClient. */
export interface FeishuConfig {
  appId: string;
  appSecret: string;
}
