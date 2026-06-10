/**
 * Feishu markdown sanitizer.
 *
 * Feishu's CardKit markdown parser occasionally fails to parse **bold** markers
 * when adjacent to non-Latin characters (CJK, fullwidth punctuation, special
 * quotes, etc.). Inserting zero-width spaces between ** and these characters
 * provides word boundaries without visible gaps.
 */

const ZWSP = '​';

/**
 * Fix **bold** parsing in Feishu markdown by inserting zero-width spaces
 * between ** delimiters and adjacent non-alphanumeric, non-whitespace chars.
 */
export function fixFeishuBold(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, (_match, content: string) => {
    let prefix = '**';
    let suffix = '**';
    const first = content[0];
    const last = content[content.length - 1];

    if (first !== undefined && first !== ' ' && first !== ZWSP && !/[a-zA-Z0-9]/.test(first)) {
      prefix = `**${ZWSP}`;
    }
    if (last !== undefined && last !== ' ' && last !== ZWSP && !/[a-zA-Z0-9]/.test(last)) {
      suffix = `${ZWSP}**`;
    }
    return prefix + content + suffix;
  });
}
