// ---------------------------------------------------------------------------
// QQ Bot API v2 type definitions for the OhMyAgent channel extension.
//
// Covers the official QQ Bot WebSocket gateway protocol and REST API
// (api.sgroup.qq.com) used by OpenClaw / OpenHanako — NOT OneBot v11.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface QQConfig {
  /** Master on/off switch for the QQ channel. */
  enabled: boolean;
  /** QQ Bot open platform AppID. */
  appId: string;
  /** QQ Bot open platform ClientSecret. */
  clientSecret: string;
  /** Use sandbox environment (sandbox.api.sgroup.qq.com). */
  sandbox: boolean;
  /** QQ user openids allowed to interact. Empty = allow all. */
  allowedUsers: string[];
  /** QQ group openids where the bot responds. Empty = allow all groups. */
  allowedGroups: string[];
  /** send = no message editing (the only option for QQ). */
  streamMode: 'send';
  /** Max characters per single message (~2000 recommended for QQ). */
  textLimit: number;
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export interface QQAccessTokenResponse {
  access_token: string;
  expires_in: number;
}

export interface QQGatewayUrlResponse {
  url: string;
}

// ---------------------------------------------------------------------------
// WebSocket Gateway Protocol
// ---------------------------------------------------------------------------

/**
 * Raw WebSocket frame received from the QQ gateway.
 */
export interface QQWsPayload {
  op: number;
  d?: unknown;
  t?: string;
  s?: number;
}

/** op 10 — server sends heartbeat interval. */
export interface QQHello {
  heartbeat_interval: number;
}

/** op 2 — client identifies itself to the gateway. */
export interface QQIdentify {
  token: string;
  intents: number;
  shard?: [number, number];
}

/** op 0 t=READY — gateway confirms the session. */
export interface QQReady {
  version: number;
  session_id: string;
  user: { id: string };
  shard: [number, number];
}

/** op 6 — client resumes a previous session. */
export interface QQResume {
  token: string;
  session_id: string;
  seq: number;
}

// ---------------------------------------------------------------------------
// Message Payloads
// ---------------------------------------------------------------------------

export interface QQAuthor {
  user_openid: string;
  member_openid?: string;
}

export interface QQAttachment {
  url: string;
  content_type: string;
  height?: number;
  width?: number;
  /** QQ built-in voice transcription text (available for voice messages). */
  asr_refer_text?: string;
  /** Direct WAV download URL for voice messages. */
  voice_wav_url?: string;
  filename?: string;
  size?: number;
}

/**
 * The `d` field payload for C2C_MESSAGE_CREATE and GROUP_AT_MESSAGE_CREATE.
 */
export interface QQMessagePayload {
  author: QQAuthor;
  content: string;
  id: string;
  timestamp: string;
  attachments?: QQAttachment[];
  /** Present for GROUP_AT_MESSAGE_CREATE. */
  group_id?: string;
  /** Present for GROUP_AT_MESSAGE_CREATE. */
  group_openid?: string;
}

export type QQMessageEventType =
  | 'C2C_MESSAGE_CREATE'
  | 'GROUP_AT_MESSAGE_CREATE'
  | 'DIRECT_MESSAGE_CREATE';

export type QQMessageEvent = QQWsPayload & {
  op: 0;
  t: QQMessageEventType;
  d: QQMessagePayload;
  s: number;
};

export function isMessageEvent(payload: QQWsPayload): payload is QQMessageEvent {
  return (
    payload.op === 0 &&
    (payload.t === 'C2C_MESSAGE_CREATE' || payload.t === 'GROUP_AT_MESSAGE_CREATE' || payload.t === 'DIRECT_MESSAGE_CREATE')
  );
}

// ---------------------------------------------------------------------------
// Keyboard Message Types (msg_type=2 markdown + keyboard)
// ---------------------------------------------------------------------------

/** Interactive keyboard attached to a markdown message. */
export interface QQKeyboard {
  content: {
    rows: QQKeyboardRow[];
  };
}

export interface QQKeyboardRow {
  buttons: QQButton[];
}

export interface QQButton {
  id: string;
  render_data: {
    label: string;
    visited_label: string;
    style: 0 | 1; // 0=灰色线框, 1=蓝色线框
  };
  action: {
    type: 0 | 1 | 2; // 0=跳转, 1=回调, 2=指令
    permission: { type: 0 | 1 | 2 }; // 0=指定用户, 1=仅管理者, 2=所有人
    data: string;
    unsupport_tips?: string;
    click_limit?: number;
  };
  /** Mutually exclusive button group. */
  group_id?: string;
}

// ---------------------------------------------------------------------------
// INTERACTION_CREATE Event (button click callback)
// ---------------------------------------------------------------------------

export interface QQInteractionData {
  resolved: {
    button_data: string;
    button_id: string;
    message_id: string;
  };
}

export interface QQInteractionEvent {
  id: string;
  type: 11 | 12; // 11=消息按钮, 12=单聊快捷菜单
  scene: 'c2c' | 'group' | 'guild';
  chat_type: 0 | 1 | 2; // 0=频道, 1=群聊, 2=单聊
  timestamp: string;
  data: QQInteractionData;
  group_openid?: string;
  group_member_openid?: string;
  user_openid?: string;
}

/** WebSocket frame type guard for INTERACTION_CREATE events. */
export function isInteractionEvent(
  payload: QQWsPayload,
): payload is QQWsPayload & { op: 0; t: 'INTERACTION_CREATE'; d: QQInteractionEvent } {
  return payload.op === 0 && payload.t === 'INTERACTION_CREATE';
}

export function isGroupMessageEvent(payload: QQWsPayload): payload is QQMessageEvent {
  return isMessageEvent(payload) && payload.t === 'GROUP_AT_MESSAGE_CREATE';
}

export function isC2cMessageEvent(payload: QQWsPayload): payload is QQMessageEvent {
  return isMessageEvent(payload) && payload.t === 'C2C_MESSAGE_CREATE';
}

// ---------------------------------------------------------------------------
// Inline Media Tag Patterns
// ---------------------------------------------------------------------------

/** Regex to find inline QQ media tags in outgoing text. */
export const INLINE_MEDIA_REGEX = /<(qqimg|qqvoice|qqvideo|qqfile)>([^<]*)<\/\1>/g;
