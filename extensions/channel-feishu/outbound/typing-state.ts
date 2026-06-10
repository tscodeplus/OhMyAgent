/**
 * Typing state indicator for Feishu chats.
 *
 * Shows a "typing..." indicator while the bot is processing.
 * Typing state is non-critical; errors are logged and swallowed.
 */

/**
 * Set the typing indicator in a Feishu chat.
 *
 * @see https://open.feishu.cn/document/server-docs/im-v1/chat/typing
 */
export async function setTypingState(
  client: { setTyping: Function },
  chatId: string,
): Promise<void> {
  return client.setTyping(chatId);
}
