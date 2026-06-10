/**
 * iLink protocol type definitions for OhMyAgent WeChat channel extension.
 */

/** WeChat channel configuration mirrored from AppConfig.wechat. */
export interface WechatConfig {
  enabled: boolean;
  botToken?: string;
  apiBase: string;
  cursorDir: string;
  textLimit: number;
  aesKey?: string;
  allowedUsers: string[];
}

/** A single item inside an iLink message's item_list. */
export interface ILMessageItem {
  type: number; // 1=text, 2=image, 3=voice, 4=file, 5=video
  text_item?: {
    text: string;
    ref_msg?: ILReferenceMessage;
  };
  image_item?: {
    media: ILMediaParam;
    mid_size?: number;
  };
  voice_item?: {
    text?: string;
    media?: ILMediaParam;
  };
  file_item?: {
    file_name: string;
    len: string;
    media: ILMediaParam;
  };
  video_item?: {
    media: ILMediaParam;
  };
}

/** Encrypted media parameter passed via iLink. */
export interface ILMediaParam {
  encrypt_query_param: string;
  aes_key: string;
  encrypt_type: number;
  /** Ciphertext (encrypted) file size in bytes; used for mid_size / hd_size */
  fileSizeCiphertext?: number;
}

/** Reference to a previous message (reply/quote). */
export interface ILReferenceMessage {
  title?: string;
  message_item: {
    type: number;
  } & Record<string, unknown>;
}

/** Inbound message from getupdates. */
export interface ILMessage {
  from_user_id: string;
  context_token: string;
  client_id: string;
  item_list: ILMessageItem[];
  to_user_id?: string;
  [key: string]: unknown;
}

/** Response from GET /ilink/bot/getupdates long-poll. */
export interface ILGetUpdatesResponse {
  get_updates_buf?: string;
  msgs?: ILMessage[];
  ret?: number;
  errcode?: string;
  errmsg?: string;
}

/** Generic iLink API response envelope. */
export interface ILApiResponse {
  ret?: number;
  errcode?: string;
  errmsg?: string;
  [key: string]: unknown;
}

/** Response from GET /ilink/bot/get_bot_qrcode. */
export interface ILQrcodeResponse {
  qrcode?: string;
  qrcode_img_content?: string;
  ret?: number;
  errcode?: string;
  errmsg?: string;
}

/** Response from GET /ilink/bot/get_qrcode_status. */
export interface ILQrcodeStatusResponse {
  status?: string;
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
  ret?: number;
  errcode?: string;
  errmsg?: string;
}

/** Response from POST /ilink/bot/getuploadurl. */
export interface ILUploadUrlResponse {
  upload_param?: string;
  ret?: number;
  errcode?: string;
  errmsg?: string;
}

/** Message type constants matching the iLink protocol. */
export const MessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

/** iLink message direction. */
export const MessageType = {
  USER: 1,
  BOT: 2,
} as const;

/** Typing status for iLink typing indicator. */
export const TypingStatus = { TYPING: 1, CANCEL: 2 } as const;

/** iLink message state. */
export const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

/** Upload media type constants. */
export const UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
} as const;
