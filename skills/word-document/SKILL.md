---
name: Word Document
description: Read, create, and edit Word (.docx) documents
metadata:
  version: "1.0.0"
  tags: ["word", "docx", "document", "office"]
  triggers:
    - Word文档
    - Word 文档
    - word文档
    - word 文档
    - Word文件
    - Word 文件
    - word文件
    - word 文件
    - docx
  x-ohmyagent:
    memoryPolicy:
      scopes:
        - type: session
          readPolicy: always
          writePolicy: on_demand
        - type: global
          readPolicy: on_demand
          writePolicy: never
      captureEnabled: false
      recallEnabled: true
priority: 4
allowed-tools: shell
---

## Role
You are a Word document specialist — you create, read, and edit .docx files. Use the `docx-helper.mjs` script via the `shell` tool.

**Script path**: `skills/word-document/scripts/docx-helper.mjs` (relative to project root)

## MUST DO
- ALWAYS read the document before editing: `node skills/word-document/scripts/docx-helper.mjs --read <file>`
- For new documents, use `--run --output <file> -c '<code>'` (no `--input` needed)
- For editing, always provide both `--input <source>` and `--output <target>` (can be the same file)
- Only use the injected variables: `doc`, `console`, `fs`, `path`, `Image`, `ImageRun`
- **Never call `doc.save()` or `doc.dispose()`** — the script handles this automatically
- When errors occur, read the stack trace, fix the code, and retry — don't give up
- When a code pattern exists in the "Common Patterns" section below, copy-paste it directly — don't invent API names

## ⚠️ Language & Field Update Settings (REQUIRED)

When creating or editing documents, you **MUST include these lines at the top of your `-c` code** to set the document language and suppress field-update prompts:

```javascript
// Set document language (affects docProps/core.xml metadata)
doc.setLanguage("zh-CN");

// Disable field-update prompts so Word doesn't ask "Update fields?" on open
doc.setUpdateFields(false);
```

### Why this matters

Word's spell checker does NOT read language metadata from `docProps/core.xml`. It only reads `<w:docDefaults><w:rPrDefault><w:rPr><w:lang .../></w:rPr></w:rPrDefault></w:docDefaults>` in `styles.xml`.

`doc.setLanguage()` primarily updates `docProps/core.xml` metadata, and also touches the main language `w:val` in styles.xml — but it does **NOT reliably set `w:eastAsia`**. You must adjust based on the document's actual language:

- `w:val="en-US"` → primary language (English by default)
- `w:eastAsia="zh-CN"` → East Asian text (e.g. Simplified Chinese) specified separately
- `w:bidi="ar-SA"` → bidirectional text (Arabic by default)

For **English-only** documents, the defaults are fine. For **French** documents, change the primary language to `fr-FR` (French has no `eastAsia` attribute).

### Language reference table

| Document Language | `setLanguage()` param | Recommended `<w:lang>` in styles.xml |
|---|---|---|
| Simplified Chinese | `"zh-CN"` | `w:val="en-US" w:eastAsia="zh-CN" w:bidi="ar-SA"` |
| Traditional Chinese | `"zh-TW"` | `w:val="en-US" w:eastAsia="zh-TW" w:bidi="ar-SA"` |
| Japanese | `"ja-JP"` | `w:val="en-US" w:eastAsia="ja-JP" w:bidi="ar-SA"` |
| Korean | `"ko-KR"` | `w:val="en-US" w:eastAsia="ko-KR" w:bidi="ar-SA"` |
| English only | `"en-US"` | `w:val="en-US" w:bidi="ar-SA"` |
| French | `"fr-FR"` | `w:val="fr-FR" w:bidi="ar-SA"` |
| German | `"de-DE"` | `w:val="de-DE" w:bidi="ar-SA"` |
| Spanish | `"es-ES"` | `w:val="es-ES" w:bidi="ar-SA"` |
| Russian | `"ru-RU"` | `w:val="ru-RU" w:bidi="ar-SA"` |

### Manual styles.xml fix (recommended for East Asian documents)

For documents containing Chinese / Japanese / Korean, manually patch `styles.xml` to ensure `w:eastAsia` is correct before saving:

```javascript
// Include at the top of your -c code (for East Asian language documents)
let stylesXml = doc.getStylesXml();
const langMap = {
  "zh-CN": 'w:val="en-US" w:eastAsia="zh-CN"',
  "zh-TW": 'w:val="en-US" w:eastAsia="zh-TW"',
  "ja-JP": 'w:val="en-US" w:eastAsia="ja-JP"',
  "ko-KR": 'w:val="en-US" w:eastAsia="ko-KR"',
};
const langCode = "zh-CN"; // Change this to match the document's language
if (langMap[langCode]) {
  stylesXml = stylesXml.replace(
    /<w:lang [^/]*\/>/,
    `<w:lang ${langMap[langCode]} w:bidi="ar-SA"/>`
  );
  doc.setStylesXml(stylesXml);
}
doc.setUpdateFields(false);
```

> **Note**: English-only documents need no extra setup — the default `en-US` is sufficient. East Asian language documents should use the manual `w:eastAsia` fix above.

## SHOULD DO
- Test on a small scope first, then expand once confirmed correct
- For large documents, work in stages, focusing on one section at a time
- Verify results with `--read` after editing
- When an operation fails, analyze the error stack, correct the code, then retry

## WHEN
- If the operation you need is NOT in "Common Patterns" → use `--api` to discover available methods first, then write code
- If API discovery still leaves uncertainty → create a small test document to verify the approach
- If an edit fails → analyze the error → fix the code → retry

## Invocation Modes

```bash
# ── API Discovery ──
node skills/word-document/scripts/docx-helper.mjs --api                    # List all introspectable types
node skills/word-document/scripts/docx-helper.mjs --api Document           # List Document method signatures
node skills/word-document/scripts/docx-helper.mjs --api Table              # List Table method signatures
node skills/word-document/scripts/docx-helper.mjs --api TableCell          # List TableCell method signatures

# ── Read Document ──
node skills/word-document/scripts/docx-helper.mjs --read input.docx        # Output structured Markdown

# ── Run Edit Code ──
node skills/word-document/scripts/docx-helper.mjs --run --input in.docx --output out.docx -c '
  doc.replaceText("old text", "new text");
  doc.createParagraph().addText("appended paragraph", { bold: true });
'
```

## API Discovery

When "Common Patterns" below doesn't cover your operation, use `--api` to introspect available methods at runtime:
- `--api` — list all introspectable types
- `--api Document` — list all Document methods
- `--api Table` — list all Table methods
- `--api Paragraph` — list all Paragraph methods
- `--api TableCell` — list all TableCell methods

Discover first, then write code. Never guess method names.

## Common Patterns

The code snippets below can be copy-pasted directly into the `-c` argument. Each example is self-contained; combine multiple snippets as needed.

### Basic Create / Edit

```
// Edit existing document: --run --input in.docx --output out.docx -c
//   Script has already called Document.load(); `doc` is the loaded document
// Create new document: --run --output new.docx -c
//   Script has already called Document.create(); `doc` is an empty document

doc.createParagraph().addText('Document Title', { bold: true, fontSize: 22 });
```

### Text Search & Replace

```
doc.replaceText('old text', 'new text');
doc.replaceText('Party A', 'Party B');
// Replaces all matching occurrences in the document
```

### Paragraph Operations

```
// Append paragraph at end
doc.createParagraph().addText('Appended content');
doc.createParagraph().addText('**bold** *italic*');
```

```
// Insert paragraph at specific position
const els = doc.getBodyElements();
const ref = els[2];  // 3rd element (0-indexed)
const newPara = doc.createParagraph().addText('Inserted paragraph');
doc.insertBefore(ref, newPara);
```

```
// Delete paragraph at specific position
const els = doc.getBodyElements();
doc.removeElement(els[0]);  // Remove first element
```

```
// Replace paragraph content
const els = doc.getBodyElements();
const newPara = doc.createParagraph().addText('New content');
doc.replaceElement(els[0], newPara);
```

### Table Operations

```
// Get all tables
const tables = doc.getBodyElements().filter(e => e.constructor.name === 'Table');
const t = tables[0];  // First table
```

```
// Read table contents
const t = doc.getBodyElements().filter(e => e.constructor.name === 'Table')[0];
for (let r = 0; r < 10; r++) {
  const row = t.getRow(r);
  if (!row) break;
  for (let c = 0; c < 10; c++) {
    const cell = row.getCell(c);
    if (!cell) break;
    const paras = cell.getParagraphs();
    const text = paras.map(p => p.getText?.() ?? '').join(' ');
    console.log(`[${r},${c}]:`, text);
  }
}
```

```
// Add row (simple — plain text cells)
const t = doc.getBodyElements().filter(e => e.constructor.name === 'Table')[0];
t.addRowFromArray(['Col1', 'Col2', 'Col3']);
```

```
// Add row (when per-cell formatting is needed)
const t = doc.getBodyElements().filter(e => e.constructor.name === 'Table')[0];
const newRow = t.createRow();
newRow.getCell(0).createParagraph().addText('Col1', { bold: true });
newRow.getCell(1).createParagraph().addText('Col2');
newRow.getCell(2).createParagraph().addText('Col3');
```

```
// Delete row
const t = doc.getBodyElements().filter(e => e.constructor.name === 'Table')[0];
const row3 = t.getRow(2);  // 3rd row (0-indexed)
doc.removeElement(row3);
```

```
// Edit cell
const t = doc.getBodyElements().filter(e => e.constructor.name === 'Table')[0];
const cell = t.getRow(1).getCell(0);
const oldPara = cell.getParagraphs()[0];
const newPara = cell.createParagraph().addText('New content');
doc.replaceElement(oldPara, newPara);
```

```
// Merge cells (horizontal)
const t = doc.getBodyElements().filter(e => e.constructor.name === 'Table')[0];
t.getRow(0).getCell(0).setHorizontalMerge(0, 2);  // Row 0, merge columns 0–2
```

```
// Merge cells (vertical)
const t = doc.getBodyElements().filter(e => e.constructor.name === 'Table')[0];
t.getRow(0).getCell(0).setVerticalMerge(0, 2);  // Column 0, merge rows 0–2
```

```
// Sort table (by column 0 ascending)
const t = doc.getBodyElements().filter(e => e.constructor.name === 'Table')[0];
t.sortRows(0, true);
```

```
// Set table borders
const t = doc.getBodyElements().filter(e => e.constructor.name === 'Table')[0];
t.setBorders({
  top: { style: 'single', size: 4, color: '000000' },
  bottom: { style: 'single', size: 4, color: '000000' },
  left: { style: 'single', size: 4, color: '000000' },
  right: { style: 'single', size: 4, color: '000000' },
});
```

### Formatting

```
// Find and bold
doc.findAndFormat('keyword', { bold: true });
```

```
// Find and set font / color
doc.findAndFormat('keyword', { bold: true, italic: true, fontSize: 16, fontName: 'SimHei', color: '#FF0000' });
```

```
// Highlight text
doc.findAndHighlight('important', 'yellow');  // yellow, green, cyan, red
```

```
// Set uniform font across entire document
doc.setAllRunsFont('SimSun');
doc.setAllRunsSize(12);
doc.setAllRunsColor('333333');
```

```
// Add heading
doc.addHeading('Chapter 1 Overview', 1);  // Heading levels 1–6
```

### Lists

```
// Bullet list
doc.addBulletListFromArray(['Item A', 'Item B', 'Item C']);
```

```
// Numbered list
doc.addNumberedListFromArray(['Step one', 'Step two', 'Step three']);
```

### Images

```
// Insert image at end of document
const buf = await fs.readFile('chart.png');
const img = new Image({ source: buf, width: 400, height: 300 });
doc.addImage(img);
```

### Hyperlinks

```
// Batch update link URLs
doc.updateHyperlinkUrls('http://old.example.com', 'https://new.example.com');
```

### Footnotes / Endnotes

```
const para = doc.getBodyElements()[5];
doc.createFootnote(para, 'This is a footnote explanation.');
doc.createEndnote(para, 'This is an endnote reference.');
```

```
doc.clearFootnotes();
doc.clearEndnotes();
```

### Template Filling

```
doc.fillTemplate({ name: 'John Doe', date: '2026-07-21', amount: '10,000' });
// Replaces all {{name}}, {{date}}, {{amount}} placeholders in the document
```

### Page Layout

```
// For page layout APIs not listed above → use --api Document to discover
// then call them directly in your -c code
```

## Injected Variables

The following variables are available in your `-c` code:
- `doc` — the loaded docxmlater Document instance (created via `Document.load()` with `--input`, or `Document.create()` without `--input`)
- `console` — logs to stdout visible to the agent (`console.error` is also visible)
- `fs` — Node.js `fs/promises` module (for async file I/O: `await fs.readFile()`, etc.)
- `path` — Node.js `path` module
- `Image` — docxmlater Image class, for creating images: `new Image({ source: buf, width: 400, height: 300 })`
- `ImageRun` — docxmlater ImageRun class (advanced; prefer `doc.addImage()` for common use)

**Never call `doc.save()` or `doc.dispose()`** — the script handles both after your code runs.

If execution fails, the error message and stack trace will be printed to stderr. Analyze the error, fix the code, and retry.

## Examples

### Good: Edit a weekly report
User: Help me change "Last Week Summary" to "This Week Summary" and add a row for Project B.
Assistant:
1. [Read] `node skills/word-document/scripts/docx-helper.mjs --read weekly.docx`
2. [Analyze] Output shows the first paragraph is "Last Week Summary", and there's a 4-row table
3. [Edit] Copy text-replace + table-add-row patterns from Common Patterns, combine into one `-c` block, execute
4. [Verify] `... --read weekly.docx` to confirm changes

### Bad: Edit without reading
User: Replace all "Party A" with "Party B" in my document.
Assistant:
1. [Jump to edit] `--run --input contract.docx --output contract.docx -c 'doc.replaceText("Party A", "Party B")'`
2. ❌ Did not `--read` first to inspect document structure — may accidentally alter unintended content
