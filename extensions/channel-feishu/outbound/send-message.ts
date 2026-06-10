/**
 * Send messages via Feishu API.
 *
 * Thin wrappers around FeishuClient that handle content formatting,
 * message/reply routing, and parameter construction.
 */

import type { FeishuApiResponse, SendMessageData } from '../feishu-types.js';

// ─── Text ───

export interface SendMessageOptions {
  chatId: string;
  text: string;
  /** If set, reply to this message instead of sending a new one. */
  replyToMessageId?: string;
}

/**
 * Send a plain text message to a Feishu chat.
 */
export async function sendTextMessage(
  client: { sendMessage: Function; replyMessage: Function },
  options: SendMessageOptions,
): Promise<FeishuApiResponse<SendMessageData>> {
  const content = JSON.stringify({ text: options.text });
  const msgType = 'text' as const;

  if (options.replyToMessageId) {
    return client.replyMessage(options.replyToMessageId, {
      receive_id_type: 'chat_id',
      receive_id: options.chatId,
      msg_type: msgType,
      content,
    });
  }

  return client.sendMessage({
    receive_id_type: 'chat_id',
    receive_id: options.chatId,
    msg_type: msgType,
    content,
  });
}

// ─── Image ───

export interface SendImageOptions {
  chatId: string;
  imageKey: string;
  replyToMessageId?: string;
}

/**
 * Send an image message to a Feishu chat.
 */
export async function sendImageMessage(
  client: { sendMessage: Function; replyMessage: Function },
  options: SendImageOptions,
): Promise<FeishuApiResponse<SendMessageData>> {
  const content = JSON.stringify({ image_key: options.imageKey });
  const msgType = 'image' as const;

  if (options.replyToMessageId) {
    return client.replyMessage(options.replyToMessageId, {
      receive_id_type: 'chat_id',
      receive_id: options.chatId,
      msg_type: msgType,
      content,
    });
  }

  return client.sendMessage({
    receive_id_type: 'chat_id',
    receive_id: options.chatId,
    msg_type: msgType,
    content,
  });
}

// ─── File ───

export interface SendFileOptions {
  chatId: string;
  fileKey: string;
  replyToMessageId?: string;
}

/**
 * Send a file message to a Feishu chat.
 */
export async function sendFileMessage(
  client: { sendMessage: Function; replyMessage: Function },
  options: SendFileOptions,
): Promise<FeishuApiResponse<SendMessageData>> {
  const content = JSON.stringify({ file_key: options.fileKey });
  const msgType = 'file' as const;

  if (options.replyToMessageId) {
    return client.replyMessage(options.replyToMessageId, {
      receive_id_type: 'chat_id',
      receive_id: options.chatId,
      msg_type: msgType,
      content,
    });
  }

  return client.sendMessage({
    receive_id_type: 'chat_id',
    receive_id: options.chatId,
    msg_type: msgType,
    content,
  });
}

// ─── Audio ───

export interface SendAudioOptions {
  chatId: string;
  fileKey: string;
  replyToMessageId?: string;
}

/**
 * Send an audio message to a Feishu chat.
 */
export async function sendAudioMessage(
  client: { sendMessage: Function; replyMessage: Function },
  options: SendAudioOptions,
): Promise<FeishuApiResponse<SendMessageData>> {
  const content = JSON.stringify({ file_key: options.fileKey });
  const msgType = 'audio' as const;

  if (options.replyToMessageId) {
    return client.replyMessage(options.replyToMessageId, {
      receive_id_type: 'chat_id',
      receive_id: options.chatId,
      msg_type: msgType,
      content,
    });
  }

  return client.sendMessage({
    receive_id_type: 'chat_id',
    receive_id: options.chatId,
    msg_type: msgType,
    content,
  });
}
