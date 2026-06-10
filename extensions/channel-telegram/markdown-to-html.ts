/**
 * Minimal Markdown-to-HTML converter for Telegram HTML parse_mode.
 *
 * Converts the most common LLM output patterns:
 *   **bold**        → <b>bold</b>
 *   *italic*        → <i>italic</i>
 *   `code`          → <code>code</code>
 *   ```lang\n...``` → <pre>...</pre>
 *   [text](url)     → <a href="url">text</a>
 *   ## heading      → <b>heading</b>  (Telegram has no heading tags)
 *   ### heading     → <b>heading</b>
 *   ---             → ——————————————— (horizontal rule emulation)
 *   - list item     → • list item
 *   1. ordered      → 1. ordered
 */

export function markdownToHtml(md: string): string {
  // Phase 0: extract and protect fenced code blocks AND tables
  const fences: string[] = [];
  let phase0 = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_full, _lang, code) => {
    fences.push(code.trimEnd());
    return `\x00FENCE${fences.length - 1}\x00`;
  });

  // Phase 0.5: convert Markdown tables to <pre> aligned text
  phase0 = convertTables(phase0);

  let phase1 = phase0;

  // Phase 1: headings (## / ###) — convert to bold since Telegram lacks heading tags.
  // Must run before bold conversion to avoid double-wrapping.
  phase1 = phase1.replace(/^### (.+)$/gm, '<b>$1</b>');
  phase1 = phase1.replace(/^## (.+)$/gm, '<b>$1</b>');

  // Phase 1.5: horizontal rules (--- on its own line)
  phase1 = phase1.replace(/^---$/gm, '———————————————');

  // Phase 2: inline code (backtick pairs)
  phase1 = phase1.replace(/`([^`\n]+)`/g, (_full, code) => {
    return `<code>${escapeHtml(code)}</code>`;
  });

  // Phase 3: bold (**text**)
  phase1 = phase1.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

  // Phase 4: italic (*text* — but not ** and not inside <b>)
  phase1 = phase1.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>');

  // Phase 5: links [text](url)
  phase1 = phase1.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_full, text, url) => {
    return `<a href="${escapeAttr(url)}">${escapeHtml(text)}</a>`;
  });

  // Phase 6: unordered list items (lines starting with - or * followed by space)
  phase1 = phase1.replace(/^[\-\*] (.*$)/gm, '• $1');

  // Phase 7: restore fenced code blocks
  phase1 = phase1.replace(/\x00FENCE(\d+)\x00/g, (_full, idx) => {
    const code = fences[parseInt(idx, 10)] ?? '';
    return `<pre>${escapeHtml(code)}</pre>`;
  });

  return phase1;
}

/**
 * Detect Markdown table blocks and convert them to aligned monospace text
 * wrapped in <pre> tags. Telegram does not support native tables.
 */
function convertTables(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Check if this line starts a table (contains | and the next line is a separator row)
    if (line.includes('|') && isTableRow(line)) {
      const tableRows: string[] = [line];
      let j = i + 1;

      // Collect header separator
      if (j < lines.length && isTableSeparator(lines[j]!)) {
        tableRows.push(lines[j]!);
        j++;
      }

      // Collect data rows
      while (j < lines.length && isTableRow(lines[j]!)) {
        tableRows.push(lines[j]!);
        j++;
      }

      // Convert to aligned monospace
      if (tableRows.length >= 2) { // at least header + one data row
        const formatted = formatTable(tableRows);
        result.push('<pre>');
        result.push(formatted);
        result.push('</pre>');
        i = j;
        continue;
      }
    }

    result.push(line);
    i++;
  }

  return result.join('\n');
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|');
}

function isTableSeparator(line: string): boolean {
  return /^\|[\s\-:|]+\|$/.test(line.trim());
}

function formatTable(rows: string[]): string {
  // Parse all rows into cells, skipping the separator row
  const data: string[][] = [];
  for (const row of rows) {
    if (isTableSeparator(row)) continue;
    const cells = row.trim().split('|').slice(1, -1).map(c => c.trim());
    data.push(cells);
  }

  if (data.length === 0) return '';

  // Calculate max column widths (cap at 40 chars to avoid excessively wide tables)
  const colCount = Math.max(...data.map(r => r.length));
  const widths: number[] = new Array(colCount).fill(3);
  for (const row of data) {
    for (let c = 0; c < row.length; c++) {
      widths[c] = Math.min(Math.max(widths[c] ?? 3, visualLength(row[c]!)), 40);
    }
  }

  // Format rows with aligned columns
  const formatted = data.map((row, idx) => {
    const cells = row.map((cell, c) => padRight(cell, widths[c] ?? 3));
    const joined = cells.join(' │ ');

    // Add separator after header
    if (idx === 0) {
      const sep = widths.map(w => '─'.repeat(w)).join('─┼─');
      return joined + '\n' + sep;
    }
    return joined;
  });

  return formatted.join('\n');
}

function visualLength(s: string): number {
  // Approximate: count CJK and emoji as 2, everything else as 1
  let len = 0;
  for (const ch of s) {
    // CJK Unified + Symbols + Fullwidth
    if (/[一-鿿　-〿＀-￯]/.test(ch)) { len += 2; continue; }
    // Emoji: broad ranges covering common symbol/dingbat/emoji blocks
    if (/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}]/u.test(ch)) { len += 2; continue; }
    // Box-drawing characters are narrow (width 1)
    len += 1;
  }
  return len;
}

function padRight(s: string, width: number): string {
  const vis = visualLength(s);
  const pad = width - vis;
  return s + (pad > 0 ? ' '.repeat(pad) : ' ');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
