/**
 * Send interactive cards via Feishu API.
 *
 * Thin wrapper around FeishuClient that handles card content serialization
 * and message/reply routing.
 */

import type { FeishuApiResponse, SendMessageData } from '../feishu-types.js';

export interface SendCardOptions {
  chatId: string;
  card: Record<string, unknown>;
  /** If set, reply to this message instead of sending a new one. */
  replyToMessageId?: string;
}

/**
 * Send an interactive card message to a Feishu chat.
 *
 * The card object is serialized to JSON and sent with msg_type 'interactive'.
 * When `replyToMessageId` is provided, the card is sent as a reply.
 *
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/create
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/reply
 */
export async function sendCard(
  client: { sendMessage: Function; replyMessage: Function },
  options: SendCardOptions,
): Promise<FeishuApiResponse<SendMessageData>> {
  const content = JSON.stringify(options.card);
  const msgType = 'interactive' as const;

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
