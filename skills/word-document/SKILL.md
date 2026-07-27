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

### Font & Color Recommendations

Use these as defaults for professional-looking documents. Match the font family to the document language.

| Context | Font (Latin) | Font (CJK) | Size (pt) | Color |
|---------|-------------|------------|-----------|-------|
| Body text | Calibri | SimSun (宋体) | 11 | `#333333` |
| Heading 1 | Calibri | SimHei (黑体) | 14–16 | `#1F3864` |
| Heading 2 | Calibri | SimHei (黑体) | 12–13 | `#2E75B6` |
| Heading 3 | Calibri | SimHei (黑体) | 11–12 | `#2E75B6` |
| Table header | Calibri Bold | SimHei Bold | 10–11 | `#FFFFFF` on dark bg |
| Footer | Calibri | SimSun | 9 | `#999999` |
| Hyperlink | (inherited) | (inherited) | – | `#0563C1` |
| Caption | Calibri Italic | SimSun Italic | 9–10 | `#666666` |

> **Rule of thumb**: Body text at 11pt with `#333333` (not pure black) reduces eye strain. Keep headings 2–5pt larger than body text for clear hierarchy.

## SHOULD DO
- Test on a small scope first, then expand once confirmed correct
- For large documents, work in stages, focusing on one section at a time
- Verify results with `--read` after editing
- When an operation fails, analyze the error stack, correct the code, then retry
- **For new documents**: ALWAYS start with the "Create a Polished Document" template to get proper styles, margins, and metadata
- **Before saving any document**: run the Pre-Save Polish Checklist (normalizeSpacing, normalizeTableBorders, etc.)
- **For Chinese/Japanese/Korean documents**: include the manual `w:eastAsia` fix from the Language section above

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

## 🎨 Create a Polished Document (START HERE for new documents)

When creating a new document from scratch, use this complete template as the base. Copy the ENTIRE block into `-c` and customize the content section.

```javascript
// ═══════════════════════════════════════════════
// 1) Page Setup
// ═══════════════════════════════════════════════
doc.setPageSize(12240, 15840);  // A4 (width, height in twips)
doc.setMargins({ top: 1440, bottom: 1440, left: 1440, right: 1440 });  // 1 inch all sides

// ═══════════════════════════════════════════════
// 2) Document Metadata
// ═══════════════════════════════════════════════
doc.setLanguage("zh-CN");
doc.setUpdateFields(false);
doc.setTitle("Document Title");
doc.setSubject("Subject");
doc.setCreator("OhMyAgent");

// ═══════════════════════════════════════════════
// 3) Apply Professional Styles
// ═══════════════════════════════════════════════
// ⚠️ IMPORTANT: doc.applyStyles() sets up the named Word styles (Heading 1/2/3, Normal)
// so all subsequent doc.addHeading() and doc.createParagraph() calls inherit these defaults.
// addHeading() IS safe to use AFTER applyStyles() is called.
doc.applyStyles({
  heading1: {
    run: { font: "Calibri", size: 28, bold: true, color: "1F3864" },
    paragraph: { spacing: { before: 480, after: 240 }, alignment: "left" }
  },
  heading2: {
    run: { font: "Calibri", size: 20, bold: true, color: "2E75B6" },
    paragraph: { spacing: { before: 360, after: 180 }, alignment: "left" }
  },
  heading3: {
    run: { font: "Calibri", size: 16, bold: true, color: "2E75B6" },
    paragraph: { spacing: { before: 240, after: 120 }, alignment: "left" }
  },
  normal: {
    run: { font: "Calibri", size: 22, color: "333333" },
    paragraph: { spacing: { after: 120 }, alignment: "left" }
  }
});

// ═══════════════════════════════════════════════
// 4) Default Font & Size (fallback for all text)
// ═══════════════════════════════════════════════
doc.setDefaultFont("Calibri");
doc.setDefaultFontSize(22);  // 11pt in half-points

// ═══════════════════════════════════════════════
// 5) Document Content — CUSTOMIZE BELOW
// ═══════════════════════════════════════════════
doc.addHeading("Document Title", 1);

doc.addHeading("Section 1", 2);
doc.createParagraph().addText("Body text goes here. Customize with your actual content.");

// ═══════════════════════════════════════════════
// 6) Pre-Save Polish
// ═══════════════════════════════════════════════
doc.normalizeSpacing();
doc.normalizeTableBorders();
doc.applyBordersToAllTables();
doc.upgradeToModernFormat();
```

### Style Presets

Replace the `applyStyles()` block with one of these color presets to match your document type:

| Preset | Use Case | Primary Color | Accent Color | Body Font |
|--------|----------|---------------|-------------|-----------|
| `professional-blue` | Business reports, weekly reports | `#1F3864` | `#2E75B6` | Calibri |
| `modern-dark` | Proposals, plans | `#2D3436` | `#636E72` | Calibri |
| `academic` | Papers, academic documents | `#333333` | `#555555` | Times New Roman |
| `warm` | Notices, announcements | `#8B4513` | `#A0522D` | Calibri |

Example for academic preset:
```javascript
doc.applyStyles({
  heading1: {
    run: { font: "Times New Roman", size: 28, bold: true, color: "333333" },
    paragraph: { spacing: { before: 480, after: 240 }, alignment: "left" }
  },
  heading2: {
    run: { font: "Times New Roman", size: 20, bold: true, color: "555555" },
    paragraph: { spacing: { before: 360, after: 180 }, alignment: "left" }
  },
  normal: {
    run: { font: "Times New Roman", size: 24, color: "333333" },
    paragraph: { spacing: { after: 160 }, alignment: "justify" }
  }
});
```

### Resume / CV Template

Use this template for creating professional resumes. Customize content sections marked with `<-- TODO -->`.

```javascript
// ═══════════════════════════════════════════════
// 1) Page Setup — tighter margins for resumes
// ═══════════════════════════════════════════════
doc.setPageSize(12240, 15840);  // A4 (width, height in twips)
doc.setMargins({ top: 720, bottom: 720, left: 1080, right: 1080 });  // 0.75" left/right, 0.5" top/bottom
doc.setLanguage("en-US");
doc.setUpdateFields(false);
doc.setTitle("Resume - [Name]");
doc.setCreator("OhMyAgent");

// ═══════════════════════════════════════════════
// 2) Styles — resume-optimized with smaller font sizes
// ═══════════════════════════════════════════════
doc.applyStyles({
  heading1: {
    run: { font: "Calibri", size: 24, bold: true, color: "1F3864" },
    paragraph: { spacing: { before: 0, after: 60 }, alignment: "left" }
  },
  heading2: {
    run: { font: "Calibri", size: 20, bold: true, color: "2E75B6" },
    paragraph: { spacing: { before: 200, after: 60 }, alignment: "left" }
  },
  normal: {
    run: { font: "Calibri", size: 21, color: "333333" },
    paragraph: { spacing: { before: 0, after: 40 }, alignment: "left" }
  }
});

// ═══════════════════════════════════════════════
// 3) Header — Name & Contact
// ═══════════════════════════════════════════════
var header = doc.createParagraph();
header.setAlignment("center");
header.setSpaceAfter(40);
header.addText("YOUR NAME", { bold: true, fontSize: 28, fontName: "Calibri", color: "1F3864" });

var contact = doc.createParagraph();
contact.setAlignment("center");
contact.setSpaceAfter(80);
contact.addText("[City, State]  |  [Phone]  |  [Email]  |  [LinkedIn]", { fontSize: 10, color: "666666" });

// Horizontal rule separator
doc.addHorizontalRule();

// ═══════════════════════════════════════════════
// 4) Professional Summary — <-- TODO: customize -->
// ═══════════════════════════════════════════════
doc.addHeading("Professional Summary", 2);
doc.createParagraph().addText("[A results-oriented professional with X years of experience in...]");

// ═══════════════════════════════════════════════
// 5) Work Experience — <-- TODO: add each role -->
// ═══════════════════════════════════════════════
doc.addHeading("Work Experience", 2);

// Helper: add one work experience entry
function addExperience(title, company, dates, bullets) {
  var titleP = doc.createParagraph();
  titleP.addText(title, { bold: true, fontSize: 11 });
  titleP.addText("  |  " + company + "  |  " + dates, { fontSize: 10, color: "666666" });
  bullets.forEach(function(b) {
    var bp = doc.createParagraph();
    bp.setLeftIndent(360);
    bp.setSpaceAfter(20);
    bp.addText("•  " + b, { fontSize: 10 });
  });
}

addExperience("Senior Developer", "ABC Corp", "2023 – Present", [
  "Led migration to microservices architecture, reducing deployment time by 60%",
  "Mentored team of 5 junior developers on best practices and code review",
  "Implemented CI/CD pipeline using GitHub Actions and Docker"
]);

addExperience("Junior Developer", "XYZ Inc", "2020 – 2023", [
  "Built RESTful APIs serving 1M+ daily requests",
  "Contributed to open-source projects in the Node.js ecosystem"
]);

// ═══════════════════════════════════════════════
// 6) Education — <-- TODO: customize -->
// ═══════════════════════════════════════════════
doc.addHeading("Education", 2);

var eduP = doc.createParagraph();
eduP.addText("Bachelor of Science in Computer Science", { bold: true, fontSize: 11 });
eduP.addText("  |  University of Example, 2023", { fontSize: 10, color: "666666" });

// ═══════════════════════════════════════════════
// 7) Skills — compact borderless table layout
// ═══════════════════════════════════════════════
doc.addHeading("Skills", 2);

var skills = ["Python", "JavaScript", "TypeScript", "React", "Node.js", "Docker", "AWS", "SQL", "Git", "CI/CD"];
var cols = 4;
var rows = Math.ceil(skills.length / cols);
var t = doc.createTable(rows, cols);

for (var i = 0; i < skills.length; i++) {
  var r = Math.floor(i / cols);
  var c = i % cols;
  t.getRow(r).getCell(c).createParagraph().addText(skills[i], { fontSize: 10 });
}

// ═══════════════════════════════════════════════
// 8) Pre-Save Polish
// ═══════════════════════════════════════════════
doc.normalizeSpacing();
doc.normalizeTableBorders();
doc.upgradeToModernFormat();
```

### Resume Design Rules

- **One page only** — keep content concise; use 10-11pt body text
- **Consistent styling** — reuse the `addExperience()` helper for each work entry
- **Bullet points** — use Unicode `•` (•) with hanging indent for achievement bullets
- **Skills table** — borderless multi-column table keeps skills compact; set borders to `{ style: "none", size: 0, color: "FFFFFF" }` for zero-width borders
- **ATS compatible** — keep it text-based; no images or photos
- **Font sizing**: Name 14-16pt bold, Section headings 12-13pt bold, Body 10-11pt, Dates/contact 9-10pt gray

## Pre-Save Polish Checklist

Before finalizing any document, run these cleanup calls near the end of your `-c` code:

```javascript
// Normalize inconsistent paragraph spacing
doc.normalizeSpacing();

// Ensure table borders look consistent
doc.normalizeTableBorders();
doc.applyBordersToAllTables();

// Center and border large images
doc.centerLargeImages();
doc.borderAndCenterLargeImages();

// Make hyperlinks look consistent (blue underline)
doc.updateAllHyperlinkColors();

// Set all tables to auto-fit layout
doc.setAllTablesLayout("autofit");

// Upgrade to modern format compatibility
doc.upgradeToModernFormat();
```

> **Note**: These are safe to call even on documents that don't have tables, images, or hyperlinks — each method is a no-op when nothing applies.

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

```
// Create a professional table with styled header row
const t = doc.createTable(4, 3);
// Header row — white text on colored background
t.getRow(0).getCell(0).createParagraph().addText('Name', { bold: true, color: 'FFFFFF', fontSize: 11 });
t.getRow(0).getCell(1).createParagraph().addText('Role', { bold: true, color: 'FFFFFF', fontSize: 11 });
t.getRow(0).getCell(2).createParagraph().addText('Status', { bold: true, color: 'FFFFFF', fontSize: 11 });
// Data rows
t.getRow(1).getCell(0).createParagraph().addText('Alice');
t.getRow(1).getCell(1).createParagraph().addText('Engineer');
t.getRow(1).getCell(2).createParagraph().addText('Active');
// Border — light gray for a clean look
t.setBorders({
  top: { style: 'single', size: 4, color: 'CCCCCC' },
  bottom: { style: 'single', size: 4, color: 'CCCCCC' },
  left: { style: 'single', size: 4, color: 'CCCCCC' },
  right: { style: 'single', size: 4, color: 'CCCCCC' },
});
```

```
// Post-process all tables near end of script
doc.normalizeTableBorders();
doc.applyBordersToAllTables();
doc.setAllTablesLayout('autofit');
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
// [⚠️ RECOMMENDED] Bold heading — uses { bold: true } for guaranteed rendering
function addBoldHeading(text) {
  var p = doc.createParagraph();
  p.addText(text, { bold: true, fontSize: 13, fontName: "Calibri" });
  return p;
}
addBoldHeading("Professional Summary");
```

> ⚠️ **`doc.addHeading()` is ONLY safe after `doc.applyStyles()`.** Without `applyStyles()`, heading styles may not render bold because generated `styles.xml` lacks heading style definitions. If you used the "Create a Polished Document" template above, `addHeading()` works correctly. If you did NOT call `applyStyles()`, use `createParagraph()` with `{ bold: true }` instead.

```
// ✅ Safe — when applyStyles() was called earlier
doc.addHeading('Chapter 1 Overview', 1);

// ✅ Fallback — works without applyStyles()
function addBoldHeading(text) {
  var p = doc.createParagraph();
  p.addText(text, { bold: true, fontSize: 13, fontName: 'Calibri' });
  return p;
}
addBoldHeading('Chapter 1 Overview');
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

### Page Setup

```
// A4 portrait (default, 210x297mm in twips)
doc.setPageSize(12240, 15840);

// A4 landscape
doc.setPageSize(15840, 12240, 'landscape');

// Margins (1440 twips = 1 inch, 720 = 0.5 inch)
doc.setMargins({ top: 1440, bottom: 1440, left: 1440, right: 1440 });  // 1" all sides
doc.setMargins({ top: 720, bottom: 720, left: 1440, right: 1440 });     // 0.5" top/bottom

// Page break between sections
doc.addPageBreak();
```

### Paragraph Formatting

```
// Centered text
var p = doc.createParagraph();
p.setAlignment('center');  // or: 'left', 'right', 'justify'
p.addText('Centered Title');

// Paragraph with extra spacing (in twips: 240 = 12pt)
var p = doc.createParagraph();
p.setSpaceBefore(240);
p.setSpaceAfter(120);
p.addText('Paragraph with spacing above and below');

// Indented paragraph (720 twips = 0.5 inch)
var p = doc.createParagraph();
p.setLeftIndent(720);
p.addText('Indented paragraph');

// First-line indent (480 twips ≈ 0.33 inch)
var p = doc.createParagraph();
p.setFirstLineIndent(480);
p.addText('Paragraph with first-line indent');
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
