/**
 * Update an existing card message via Feishu API.
 *
 * Thin wrapper around FeishuClient.updateMessage() for non-CardKit card updates.
 * Used for streaming card updates where the full card content is replaced.
 */

export interface UpdateCardOptions {
  /** The message_id of the existing card message to update. */
  messageId: string;
  /** The new card content (will be serialized to JSON). */
  card: Record<string, unknown>;
}

/**
 * Update an existing interactive card message.
 *
 * Replaces the full card content. Used primarily for streaming updates
 * where the card is progressively updated as the agent generates content.
 *
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/patch
 */
export async function updateCard(
  client: { updateMessage: Function },
  options: UpdateCardOptions,
): Promise<void> {
  return client.updateMessage(options.messageId, 'interactive', options.card);
}
