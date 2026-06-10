/**
 * Low-level iLink message sending.
 *
 * Provides the raw API calls for sending text/media messages via the
 * iLink protocol, plus a chunked text helper.
 */

import crypto from 'node:crypto';
import type { Logger } from 'pino';
import { apiPost } from './wechat-api.js';
import type { ILApiResponse } from './wechat-types.js';

const CHUNK_DELAY_MS = 500;

/**
 * Send a message via the iLink protocol.
 *
 * Builds the proper item_list format from msgType/msgContent, or uses
 * an explicit itemList if provided (for media messages).
 *
 * @param apiBase    iLink API base URL.
 * @param botToken   Bot authentication token.
 * @param params     contextToken (from a received message), msgType, msgContent,
 *                   and optionally itemList for media.
 */
export async function sendMessage(
  apiBase: string,
  botToken: string,
  params: {
    toUserId: string;
    contextToken: string;
    msgType: number;
    msgContent: string;
    itemList?: unknown[];
    messageState?: number;
  },
): Promise<void> {
  const { toUserId, contextToken, msgType, msgContent, itemList, messageState = 2 } = params;

  const items = itemList ?? buildItemList(msgType, msgContent);
  if (items.length === 0) {
    return; // Nothing to send
  }

  const body = {
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: crypto.randomUUID(),
      message_type: 2, // BOT
      message_state: messageState, // FINISH (2) by default
      item_list: items,
      context_token: contextToken,
    },
  };

  const _resp: ILApiResponse = await apiPost(
    apiBase,
    botToken,
    'ilink/bot/sendmessage',
    body,
    30_000, // longer timeout for sendmessage (default 10s too short)
  );
}

/**
 * Build the item_list array for a given message type and content.
 */
function buildItemList(msgType: number, msgContent: string): unknown[] {
  if (msgType === 1) {
    return [{ type: 1, text_item: { text: msgContent } }];
  }
  // Other types (image, file, etc.) use msgContent as a JSON-encoded
  // media param and are handled by wechat-media.ts.
  return [];
}

/**
 * Split long text at the configured textLimit and send each chunk sequentially
 * with a small delay between chunks to avoid iLink rate limiting.
 *
 * @returns Array of successfully sent message text segments (for logging).
 */
export async function sendChunkedText(
  apiBase: string,
  botToken: string,
  toUserId: string,
  contextToken: string,
  text: string,
  textLimit: number,
  logger?: Logger,
  placeholder?: boolean,
): Promise<string[]> {
  const chunks = splitText(text, textLimit);
  const sent: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    try {
      await sendMessage(apiBase, botToken, {
        toUserId,
        contextToken,
        msgType: 1,
        msgContent: chunk,
        messageState: placeholder && i === 0 ? 1 : 2, // GENERATING for first chunk when placeholder
      });
      sent.push(chunk);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger?.error({ err, chunk: i, errMsg }, 'Failed to send WeChat text chunk');
      // Continue with remaining chunks even if one fails
    }

    // iLink rate-limits consecutive messages — delay between chunks
    if (i < chunks.length - 1) {
      await sleep(CHUNK_DELAY_MS);
    }
  }

  return sent;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Split text into chunks at most `limit` characters.
 * WeChat does not support HTML formatting, so simple character-level
 * splitting is sufficient.
 */
function splitText(text: string, limit: number): string[] {
  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += limit) {
    chunks.push(text.slice(i, i + limit));
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
