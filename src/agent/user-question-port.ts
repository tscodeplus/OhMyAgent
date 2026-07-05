/**
 * Channel-agnostic user question port.
 *
 * The ask_user_question tool must present a question to the user and wait for
 * their answer, but it must NOT know how a given channel renders that question
 * (Feishu interactive cards, Telegram inline keyboards, a WebUI prompt, …).
 * This port is the seam:
 *
 *   - UserQuestionSender sends the question UI and optionally closes it.
 *   - Concrete implementations live in each channel extension.
 *   - The tool's execute() calls sendQuestion(), then awaits the
 *     UserQuestionStore Promise, then calls closeQuestion() on resolution.
 */

export interface UserQuestionOption {
  /** Display text shown on the button / option label. */
  label: string;
  /** Value returned when this option is selected. */
  value: string;
}

/**
 * The minimal "send question + close" contract each channel implements.
 *
 * Implementations live in:
 *   extensions/channel-feishu/render/user-question-sender.ts
 *   extensions/channel-telegram/user-question-sender.ts
 *   extensions/channel-qq/user-question-sender.ts
 *   extensions/channel-wechat/user-question-sender.ts
 *   src/app/webui/user-question-sender.ts
 */
export interface UserQuestionSender {
  /**
   * Send the question to the user via the channel's native UI.
   *
   * @returns A message/card identifier (opaque to the caller) that can be
   *          passed to closeQuestion(), or undefined if the platform doesn't
   *          support referencing sent messages.
   */
  sendQuestion(
    chatId: string,
    requestId: string,
    question: string,
    options?: UserQuestionOption[],
  ): Promise<string | undefined>;

  /**
   * Called after the answer arrives, to update the question UI (e.g. disable
   * buttons, show the selected answer, recall the card).
   *
   * Best-effort — callers must not break if this throws or is undefined.
   */
  closeQuestion?(
    chatId: string,
    cardMessageId: string | undefined,
    answer: string,
  ): Promise<void>;
}
