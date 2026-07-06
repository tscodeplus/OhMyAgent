/**
 * Feishu API client.
 *
 * Hybrid approach:
 * - SDK (@larksuiteoapi/node-sdk) for CardKit APIs and im.message.reply/create
 * - Raw fetch for token management, text messages, non-CardKit card updates,
 *   typing state, and emoji reactions
 */

import { Readable } from 'node:stream';
import type { Logger } from 'pino';
import * as lark from '@larksuiteoapi/node-sdk';
import type { FeishuApiResponse, FeishuConfig, FeishuSendMessageParams, SendMessageData } from './feishu-types.js';

const RATE_LIMIT_CODE = 99991400;
const CARD_ID_INVALID_CODE = 230099;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1500;
const CARD_ID_RETRY_ATTEMPTS = 5;
const CARD_ID_RETRY_BASE_DELAY_MS = 300;

function isRateLimited(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return msg.includes(String(RATE_LIMIT_CODE))
    || msg.includes('200400')
    || msg.includes('frequency limit');
}

function isInvalidCardIdResponse(response: { code?: number; msg?: string } | undefined): boolean {
  if (!response || response.code !== CARD_ID_INVALID_CODE) return false;
  const msg = response.msg?.toLowerCase() ?? '';
  return msg.includes('cardid is invalid') || msg.includes('errcode: 11310');
}

/**
 * Check whether an error (caught in a catch block) represents a
 * "cardid is invalid" failure from the Feishu API (code 230099).
 *
 * The Feishu SDK throws on HTTP 400 errors with code/msg buried in
 * different shapes depending on the SDK version and error path:
 *   - `err.code` / `err.msg`                   (direct properties)
 *   - `err.response.code` / `err.response.msg` (axios-style)
 *   - `err.data.code` / `err.data.msg`         (SDK data wrapper)
 *   - `err.response.data.code` / …             (nested axios)
 *   - inside `err.message` string               (fallback)
 *
 * This function normalises ALL known shapes so callers can reliably
 * decide whether to recreate the card.
 */
export function isCardIdInvalidError(err: unknown): boolean {
  if (!(err instanceof Error) && typeof err !== 'object') return false;
  if (err === null) return false;

  const obj = err as Record<string, unknown>;

  // ── Extract code from every known nesting shape ──
  const response = obj.response as Record<string, unknown> | undefined;
  const data = obj.data as Record<string, unknown> | undefined;
  const respData = response?.data as Record<string, unknown> | undefined;

  const code: number | undefined =
    (obj.code as number | undefined)
    ?? (data?.code as number | undefined)
    ?? (response?.code as number | undefined)
    ?? (respData?.code as number | undefined);

  if (code === CARD_ID_INVALID_CODE) return true;

  // ── Extract msg from every known nesting shape ──
  const msg: string | undefined =
    (obj.msg as string | undefined)
    ?? (data?.msg as string | undefined)
    ?? (response?.msg as string | undefined)
    ?? (respData?.msg as string | undefined);

  if (msg) {
    const lower = msg.toLowerCase();
    if (lower.includes('cardid is invalid') || lower.includes('errcode: 11310')) {
      return true;
    }
  }

  // ── Fallback: inspect the message string ──
  const message = String(
    (obj as { message?: string }).message
    ?? msg
    ?? String(err)
  ).toLowerCase();
  return message.includes('cardid is invalid') || message.includes('errcode: 11310');
}

/**
 * Normalise the various response formats from the Feishu SDK's binary endpoints
 * into a single Buffer.
 *
 * The SDK can return Buffer, ArrayBuffer, objects with .data, .getReadableStream(),
 * .writeFile(), async iterables, or Node Readable streams.
 */
async function extractBufferFromResponse(response: unknown): Promise<{ buffer: Buffer; contentType?: string }> {
  if (Buffer.isBuffer(response)) {
    return { buffer: response };
  }
  if (response instanceof ArrayBuffer) {
    return { buffer: Buffer.from(response) };
  }
  if (response == null) {
    throw new Error('[feishu-client] Received null/undefined response from media endpoint');
  }

  const resp = response as Record<string, unknown>;

  const headers = resp.headers as Record<string, string> | undefined;
  const contentType = headers?.['content-type'] ?? headers?.['Content-Type']
    ?? (resp.contentType as string | undefined);

  // .data as Buffer or ArrayBuffer
  if (resp.data != null) {
    if (Buffer.isBuffer(resp.data)) {
      return { buffer: resp.data, contentType };
    }
    if (resp.data instanceof ArrayBuffer) {
      return { buffer: Buffer.from(resp.data), contentType };
    }
    // .data as Readable stream
    if (typeof (resp.data as { pipe?: unknown }).pipe === 'function') {
      return { buffer: await streamToBuffer(resp.data as NodeJS.ReadableStream), contentType };
    }
  }

  // .getReadableStream()
  if (typeof resp.getReadableStream === 'function') {
    const stream = await (resp.getReadableStream as () => Promise<NodeJS.ReadableStream>)();
    return { buffer: await streamToBuffer(stream), contentType };
  }

  // Async iterable
  if (typeof (resp as any)[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = [];
    for await (const chunk of (resp as unknown) as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    return { buffer: Buffer.concat(chunks), contentType };
  }

  // Node Readable stream
  if (typeof resp.pipe === 'function') {
    return { buffer: await streamToBuffer((resp as unknown) as NodeJS.ReadableStream), contentType };
  }

  throw new Error('[feishu-client] Unable to extract binary data from response: ' + typeof response);
}

/** Consume a Readable stream into a Buffer. */
function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

export class FeishuClient {
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly logger: Logger;
  private readonly sdk: lark.Client;

  constructor(config: FeishuConfig, logger: Logger) {
    this.appId = config.appId;
    this.appSecret = config.appSecret;
    this.logger = logger.child({ module: 'feishu-client' });
    this.sdk = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      disableTokenCache: false,
    });
  }

  /** Retry a CardKit API call with exponential backoff on rate limit (99991400). */
  private async withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (!isRateLimited(err) || attempt === MAX_RETRIES) throw err;
        const delay = BASE_DELAY_MS * (2 ** attempt);
        this.logger.info({ attempt: attempt + 1, delay, label }, 'Rate limited, retrying');
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw lastErr;
  }

  // ─── Token Management ───

  /**
   * Get a valid tenant access token, refreshing if necessary.
   * Token expires in ~2 hours; refreshes 5 minutes before expiry.
   */
  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }

    this.logger.debug('Refreshing Feishu tenant access token');

    const response = await fetch(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          app_id: this.appId,
          app_secret: this.appSecret,
        }),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to get tenant access token: ${response.status} ${text}`);
    }

    const result = (await response.json()) as {
      code: number;
      msg: string;
      tenant_access_token?: string;
      expire?: number;
    };

    if (result.code !== 0) {
      throw new Error(`Token API error ${result.code}: ${result.msg}`);
    }

    if (!result.tenant_access_token) {
      throw new Error(`Token API returned no token: ${JSON.stringify(result)}`);
    }

    this.accessToken = result.tenant_access_token;
    // Refresh 5 minutes before expiry.
    this.tokenExpiresAt = Date.now() + ((result.expire ?? 7200) - 300) * 1000;

    this.logger.debug({ expiresIn: result.expire }, 'Feishu token refreshed');
    return this.accessToken;
  }

  /**
   * Invalidate the cached access token (e.g. on auth error).
   */
  invalidateToken(): void {
    this.accessToken = null;
    this.tokenExpiresAt = 0;
  }

  // ─── Raw Fetch Helper ───

  /**
   * Internal helper for authenticated Feishu API calls via raw fetch.
   */
  private async fetchApi(method: string, path: string, body?: unknown): Promise<any> {
    const token = await this.getAccessToken();
    const response = await fetch(`https://open.feishu.cn/open-apis${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Feishu API error: ${response.status} ${text}`);
    }

    return response.json();
  }

  // ─── Messages (raw fetch) ───

  /**
   * Send a message to a Feishu chat or user.
   *
   * @see https://open.feishu.cn/document/server-docs/im-v1/message/create
   */
  async sendMessage(params: FeishuSendMessageParams): Promise<FeishuApiResponse<SendMessageData>> {
    this.logger.debug({ receiveId: params.receive_id, msgType: params.msg_type }, 'Sending Feishu message');

    const body: Record<string, unknown> = {
      receive_id: params.receive_id,
      msg_type: params.msg_type,
      content: params.content,
    };
    if (params.uuid) {
      body.uuid = params.uuid;
    }

    const result = await this.fetchApi(
      'POST',
      `/im/v1/messages?receive_id_type=${params.receive_id_type}`,
      body,
    );

    if (result.code !== 0) {
      throw new Error(`Feishu API error code ${result.code}: ${result.msg}`);
    }

    return result;
  }

  /**
   * Reply to a specific message.
   *
   * @see https://open.feishu.cn/document/server-docs/im-v1/message/reply
   */
  async replyMessage(
    messageId: string,
    params: FeishuSendMessageParams,
  ): Promise<FeishuApiResponse<SendMessageData>> {
    this.logger.debug({ messageId, msgType: params.msg_type }, 'Replying to Feishu message');

    const body = {
      msg_type: params.msg_type,
      content: params.content,
    };

    const result = await this.fetchApi(
      'POST',
      `/im/v1/messages/${messageId}/reply`,
      body,
    );

    if (result.code !== 0) {
      throw new Error(`Feishu API error code ${result.code}: ${result.msg}`);
    }

    return result;
  }

  /**
   * Update an existing interactive card message (non-CardKit).
   *
   * @see https://open.feishu.cn/document/server-docs/im-v1/message/patch
   */
  async updateMessage(messageId: string, msgType: string, card: Record<string, unknown>): Promise<void> {
    this.logger.debug({ messageId }, 'Updating Feishu message');

    const result = await this.fetchApi(
      'PATCH',
      `/im/v1/messages/${messageId}`,
      { msg_type: msgType, content: JSON.stringify(card) },
    );

    if (result.code !== 0) {
      throw new Error(`Feishu API error code ${result.code}: ${result.msg}`);
    }
  }

  /**
   * Recall a previously sent message.
   *
   * Feishu allows bots to recall messages they sent within 24 hours.
   */
  async recallMessage(messageId: string): Promise<void> {
    this.logger.debug({ messageId }, 'Recalling Feishu message');

    const result = await this.fetchApi(
      'DELETE',
      `/im/v1/messages/${messageId}`,
    );

    if (result.code !== 0) {
      throw new Error(`Feishu API error code ${result.code}: ${result.msg}`);
    }
  }

  // ─── CardKit (SDK) ───

  /**
   * Create a CardKit card entity.
   * Returns the card_id for streaming updates.
   */
  async createCard(cardData: Record<string, unknown>): Promise<string> {
    const response = await this.sdk.cardkit.v1.card.create({
      data: {
        type: 'card_json',
        data: JSON.stringify(cardData),
      },
    }) as { code?: number; msg?: string; data?: { card_id?: string }; card_id?: string };

    if (response.code && response.code !== 0) {
      throw new Error(`CardKit card.create error ${response.code}: ${response.msg}`);
    }

    const cardId = response.data?.card_id ?? response.card_id;
    if (!cardId) {
      throw new Error(`CardKit card.create returned no card_id: ${JSON.stringify(response)}`);
    }

    this.logger.debug({ cardId }, 'CardKit card created');
    return cardId;
  }

  /**
   * Update a CardKit card (replace full content).
   */
  async updateCard(cardId: string, cardData: Record<string, unknown>, sequence: number): Promise<void> {
    await this.withRetry(async () => {
      this.logger.debug({ cardId, sequence, cardDataKeys: Object.keys(cardData) }, 'CardKit card.update called');
      const resp = await this.sdk.cardkit.v1.card.update({
        data: {
          card: { type: 'card_json', data: JSON.stringify(cardData) },
          sequence,
        },
        path: { card_id: cardId },
      });

      const r = resp as { code?: number; msg?: string };
      if (r.code && r.code !== 0) {
        const err = new Error(`CardKit card.update error ${r.code}: ${r.msg}`);
        this.logger.debug({ code: r.code, msg: r.msg, cardId, sequence }, err.message);
        throw err;
      }
    }, 'updateCard');
  }

  /**
   * Stream content to a CardKit card element (typewriter effect).
   * The content is cumulative (not delta). Sequence must be monotonically increasing.
   */
  async streamCardContent(cardId: string, elementId: string, content: string, sequence: number): Promise<void> {
    await this.withRetry(async () => {
      const resp = await this.sdk.cardkit.v1.cardElement.content({
        data: { content, sequence },
        path: { card_id: cardId, element_id: elementId },
      }) as { code?: number; msg?: string };

      if (resp.code && resp.code !== 0) {
        const err = new Error(`CardKit streamCardContent error ${resp.code}: ${resp.msg}`);
        this.logger.debug({ code: resp.code, msg: resp.msg, cardId, sequence }, err.message);
        throw err;
      }
    }, 'streamCardContent');
  }

  /**
   * Close (or open) streaming mode on a CardKit card.
   * Must be called after streaming completes.
   */
  async setCardStreamingMode(cardId: string, streamingMode: boolean, sequence: number): Promise<void> {
    await this.withRetry(async () => {
      this.logger.debug({ cardId, streamingMode, sequence }, 'CardKit setCardStreamingMode called');
      const resp = await this.sdk.cardkit.v1.card.settings({
        data: {
          settings: JSON.stringify({ streaming_mode: streamingMode }),
          sequence,
        },
        path: { card_id: cardId },
      }) as { code?: number; msg?: string };

      if (resp.code && resp.code !== 0) {
        const err = new Error(`CardKit setStreamingMode error ${resp.code}: ${resp.msg}`);
        this.logger.debug({ code: resp.code, msg: resp.msg, cardId, streamingMode, sequence }, err.message);
        throw err;
      }
      this.logger.debug({ cardId, streamingMode, sequence }, 'CardKit setCardStreamingMode success');
    }, 'setStreamingMode');
  }

  /**
   * Send a card message referencing a CardKit card_id via SDK.
   * If replyToMessageId is provided, sends as a reply.
   */
  async sendCardByCardId(chatId: string, cardId: string, replyToMessageId?: string): Promise<string> {
    const contentPayload = JSON.stringify({
      type: 'card',
      data: { card_id: cardId },
    });

    let lastError: { code?: number; msg?: string } | undefined;

    for (let attempt = 0; attempt <= CARD_ID_RETRY_ATTEMPTS; attempt++) {
      try {
        let response: { code?: number; msg?: string; data?: { message_id?: string } } | undefined;

        if (replyToMessageId) {
          response = await this.sdk.im.message.reply({
            path: { message_id: replyToMessageId },
            data: {
              msg_type: 'interactive',
              content: contentPayload,
            },
          }) as { code?: number; msg?: string; data?: { message_id?: string } };
        } else {
          response = await this.sdk.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'interactive',
              content: contentPayload,
            },
          }) as { code?: number; msg?: string; data?: { message_id?: string } };
        }

        // Success: got a valid message_id
        if (!response?.code || response.code === 0) {
          const messageId = response?.data?.message_id;
          if (messageId) {
            this.logger.debug({ chatId, cardId, messageId, replyToMessageId }, 'CardKit card message sent');
            return messageId;
          }
          throw new Error('sendCardByCardId returned no message_id');
        }

        // Non-success response code — check if retriable
        lastError = { code: response.code, msg: response.msg };
        if (!isInvalidCardIdResponse(response)) break;
      } catch (err: any) {
        // Feishu SDK throws on HTTP errors (e.g. 400) instead of returning
        // an error response object. Extract code/msg from every known shape:
        //   err.code / err.msg             — direct SDK error properties
        //   err.data.code / err.data.msg   — SDK data wrapper
        //   err.response.code / …          — axios-style nesting
        //   err.response.data.code / …     — nested axios
        const code = err?.code
          ?? err?.data?.code
          ?? err?.response?.code
          ?? err?.response?.data?.code;
        const msg = err?.msg
          ?? err?.data?.msg
          ?? err?.response?.msg
          ?? err?.response?.data?.msg
          ?? err?.message
          ?? String(err);
        lastError = { code, msg };

        if (!isInvalidCardIdResponse({ code, msg })) break;
      }

      // Retriable — card_id not yet usable
      if (attempt < CARD_ID_RETRY_ATTEMPTS) {
        const delay = CARD_ID_RETRY_BASE_DELAY_MS * (attempt + 1);
        this.logger.info({
          attempt: attempt + 1,
          delay,
          cardId,
          chatId,
          replyToMessageId,
          code: lastError?.code,
          msg: lastError?.msg,
        }, 'CardKit card_id not yet usable, retrying sendCardByCardId');
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw new Error(`sendCardByCardId error ${lastError?.code ?? 'unknown'}: ${lastError?.msg ?? 'no response'}`);
  }

  // ─── Approval Cards ───

  /**
   * Send an approval card to a chat.
   * Uses the standard message API with interactive card format.
   */
  async sendApprovalCard(chatId: string, card: Record<string, unknown>): Promise<string> {
    this.logger.debug({ chatId }, 'Sending approval card');
    const response = await this.sendMessage({
      receive_id: chatId,
      receive_id_type: 'chat_id',
      msg_type: 'interactive',
      content: JSON.stringify(card),
    });

    const messageId = response?.data?.message_id;
    if (!messageId) {
      throw new Error('sendApprovalCard returned no message_id');
    }
    return messageId;
  }

  // ─── Typing State (raw fetch) ───

  /**
   * Show typing indicator in a chat.
   * Non-critical: errors are logged and swallowed.
   */
  async setTyping(chatId: string): Promise<void> {
    try {
      await this.fetchApi(
        'POST',
        `/im/v1/chats/${chatId}/user_typing_status`,
        { action: 'typing' },
      );
    } catch (error) {
      this.logger.info({ error, chatId }, 'Failed to set typing state (non-critical)');
    }
  }

  /**
   * Clear typing indicator in a chat.
   */
  async clearTyping(chatId: string): Promise<void> {
    try {
      await this.fetchApi(
        'POST',
        `/im/v1/chats/${chatId}/user_typing_status`,
        { action: 'cancel' },
      );
    } catch (error) {
      this.logger.info({ error, chatId }, 'Failed to clear typing state (non-critical)');
    }
  }

  // ─── Emoji Reaction (raw fetch) ───

  /**
   * Add an emoji reaction to a message.
   * Returns the reaction_id for later removal, or null on failure.
   */
  async addReaction(messageId: string, emojiType: string = 'Typing'): Promise<string | null> {
    try {
      const result = await this.fetchApi(
        'POST',
        `/im/v1/messages/${messageId}/reactions`,
        { reaction_type: { emoji_type: emojiType } },
      );

      if (result.code !== 0) {
        this.logger.info({ code: result.code, messageId }, 'Failed to add reaction (non-critical)');
        return null;
      }

      return result?.data?.reaction_id ?? null;
    } catch (error) {
      this.logger.info({ error, messageId }, 'Failed to add reaction (non-critical)');
      return null;
    }
  }

  /**
   * Remove an emoji reaction from a message.
   */
  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    try {
      const token = await this.getAccessToken();
      const response = await fetch(
        `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reactions/${reactionId}`,
        {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        },
      );

      if (!response.ok) {
        this.logger.info({ status: response.status }, 'Failed to remove reaction (non-critical)');
      }
    } catch (error) {
      this.logger.info({ error, messageId }, 'Failed to remove reaction (non-critical)');
    }
  }

  // ─── Media: Download & Upload ───

  /**
   * Download a media resource (image/file) from a Feishu message.
   *
   * @see https://open.feishu.cn/document/server-docs/im-v1/message-resource/get
   */
  async downloadResource(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
  ): Promise<{ buffer: Buffer; contentType?: string; fileName?: string }> {
    this.logger.debug({ messageId, fileKey, type }, 'Downloading Feishu message resource');

    const response = await this.sdk.im.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type },
    });

    const result = await extractBufferFromResponse(response);

    let fileName: string | undefined;
    if (response && typeof response === 'object') {
      const resp = response as Record<string, unknown>;
      const disposition = (resp.headers as Record<string, string> | undefined)?.['content-disposition']
        ?? (resp.headers as Record<string, string> | undefined)?.['Content-Disposition'];
      if (typeof disposition === 'string') {
        const match = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
        if (match) {
          fileName = match[1].replace(/['"]/g, '');
        }
      }
    }

    return { buffer: result.buffer, contentType: result.contentType, fileName };
  }

  /**
   * Upload an image to Feishu IM storage.
   * Returns the image_key needed to send an image message.
   *
   * @see https://open.feishu.cn/document/server-docs/im-v1/image/create
   */
  async uploadImage(
    image: Buffer | string,
    imageType: 'message' | 'avatar' = 'message',
  ): Promise<{ imageKey: string }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const imageStream: any = Buffer.isBuffer(image)
      ? Readable.from(image)
      : await this.createFileReadStream(image);

    const response = await this.sdk.im.image.create({
      data: { image_type: imageType, image: imageStream },
    }) as { code?: number; msg?: string; data?: { image_key?: string }; image_key?: string };

    if (response.code && response.code !== 0) {
      throw new Error(`Image upload failed: ${response.code} ${response.msg}`);
    }

    const imageKey = response.data?.image_key ?? response.image_key;
    if (!imageKey) {
      throw new Error(`Image upload failed: no image_key in response. Response: ${JSON.stringify(response).slice(0, 200)}`);
    }

    this.logger.debug({ imageKey }, 'Image uploaded to Feishu');
    return { imageKey };
  }

  /**
   * Upload a file to Feishu IM storage.
   * Returns the file_key needed to send a file/audio/video message.
   *
   * @see https://open.feishu.cn/document/server-docs/im-v1/file/create
   */
  async uploadFile(
    file: Buffer | string,
    fileName: string,
    fileType: 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream',
    duration?: number,
  ): Promise<{ fileKey: string }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fileStream: any = Buffer.isBuffer(file)
      ? Readable.from(file)
      : await this.createFileReadStream(file);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: Record<string, any> = {
      file_type: fileType,
      file_name: fileName,
      file: fileStream,
    };
    if (duration !== undefined) {
      data.duration = String(duration);
    }

    const response = await this.sdk.im.file.create({ data } as any) as {
      code?: number; msg?: string; data?: { file_key?: string }; file_key?: string;
    };

    if (response.code && response.code !== 0) {
      throw new Error(`File upload failed: ${response.code} ${response.msg}`);
    }

    const fileKey = response.data?.file_key ?? response.file_key;
    if (!fileKey) {
      throw new Error(`File upload failed: no file_key in response for "${fileName}". Response: ${JSON.stringify(response).slice(0, 200)}`);
    }

    this.logger.debug({ fileKey, fileName }, 'File uploaded to Feishu');
    return { fileKey };
  }

  /**
   * Create a Readable stream from a file path (for ESM dynamic import of fs).
   */
  private async createFileReadStream(filePath: string): Promise<Readable> {
    const { createReadStream } = await import('node:fs');
    return createReadStream(filePath);
  }
}
