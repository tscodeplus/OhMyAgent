# DOCX 编辑能力 — 纯 Skill + 脚本方案

## 1. 设计理念

**零 TypeScript 工具代码。零 TypeBox schema。零注册。**

所有 DOCX 能力通过 Skill + 一个脚本文件 + `shell` 工具实现。Agent 直接调用 docxmlater API，无需等待开发者封装。

### 与 ToolDefinition 方案对比

| | ToolDefinition 方案 | 纯 Skill + 脚本方案 |
|---|---|---|
| 新增 TS 代码 | ~300 行 | **0 行** |
| 需改动的项目文件 | 5 个（tool-services.ts, builtins/index.ts 等） | **0 个** |
| npm 依赖 | `docxmlater` | `docxmlater` |
| Agent 发现新 API | 等开发者改 schema + 发版 | **运行时即时发现** |
| SKILL.md 大小 | 无（工具参数 schema 即文档） | ~180 行（常用片段完整，冷门靠 `--api`） |
| 权限控制 | PolicyCenter 独立配置 | 走 shell 工具的现有 policy |

### 核心思想

Skill 告诉 Agent **怎么自己发现 docxmlater 的 API**，而不是把 API 清单写在 SKILL.md 里。Agent 通过脚本的 `--api` 模式在运行时探查可用方法，然后现场编写调用代码。

---

## 2. 脚本设计：`docx-helper.mjs`

约 160 行，放在 `skills/word-document/scripts/` 下。

### 2.1 调用模式

```bash
# ── 发现 API ──
node <skill_dir>/scripts/docx-helper.mjs --api                    # 列出所有可探查的类型
node <skill_dir>/scripts/docx-helper.mjs --api Document           # 列出 Document 的方法签名
node <skill_dir>/scripts/docx-helper.mjs --api Table              # 列出 Table 的方法签名
node <skill_dir>/scripts/docx-helper.mjs --api TableCell          # 列出 TableCell 的方法签名

# ── 读取文档 ──
node <skill_dir>/scripts/docx-helper.mjs --read input.docx        # 输出结构化 Markdown

# ── 运行编辑代码 ──
node <skill_dir>/scripts/docx-helper.mjs --run --input in.docx --output out.docx -c '
  doc.replaceText(/旧文本/g, "新文本");
  doc.createParagraph().addText("追加段落", { bold: true });
'
```

### 2.2 实现骨架

```javascript
#!/usr/bin/env node
// docx-helper.mjs — 轻量 docxmlater CLI，供 Agent 通过 shell 工具调用
//
// 无需用户手动安装 docxmlater。首次运行自动通过 pnpm add 安装。
// 后续运行直接使用已安装的包。

import { promises as fs } from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// ═══════════════════════════════════════════════════════════════════
// 自动安装 docxmlater（如果尚未安装）
// ═══════════════════════════════════════════════════════════════════
let Document;
try {
  ({ Document } = await import('docxmlater'));
} catch {
  console.log('docxmlater 未安装，正在自动安装...');
  execSync('pnpm add docxmlater', { stdio: 'inherit', cwd: process.cwd() });
  ({ Document } = await import('docxmlater'));
  console.log('docxmlater 安装完成');
}

// 简易参数解析（避免引入额外依赖）
const argv = process.argv.slice(2);
const args = { code: '' };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--api')    args.api = argv[++i] ?? true;
  if (a === '--read')   args.read = argv[++i];
  if (a === '--run')    args.run = true;
  if (a === '--input')  args.input = argv[++i];
  if (a === '--output') args.output = argv[++i];
  if (a === '-c')       args.code = argv[++i];
}

// ═══════════════════════════════════════════════════════════════════
// --api : API 发现模式
// ═══════════════════════════════════════════════════════════════════
if (args.api) {
  const target = typeof args.api === 'string' ? args.api : null;
  console.log(introspect(target));
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════════
// --read : 读取模式。返回结构化 Markdown。
// ═══════════════════════════════════════════════════════════════════
if (args.read) {
  const doc = await Document.load(args.read);
  const md = docToMarkdown(doc);
  console.log(md.slice(0, 50000));
  doc.dispose();
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════════
// --run : 编辑模式。注入 doc, console, fs, path 到 Agent 代码的上下文。
// ═══════════════════════════════════════════════════════════════════
if (args.run) {
  const doc = args.input
    ? await Document.load(args.input, { revisionHandling: 'preserve' })
    : Document.create();

  try {
    const fn = new AsyncFunction('doc', 'console', 'fs', 'path', args.code);
    await fn(doc, console, fs, path);
    const outPath = args.output ?? args.input;
    if (outPath) {
      await doc.save(outPath);
      console.log(`SAVED: ${outPath}`);
    }
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    process.exit(1);
  } finally {
    doc.dispose();
  }
}

// ═══════════════════════════════════════════════════════════════════
// docToMarkdown — 将 Document 转为结构化 Markdown
// ═══════════════════════════════════════════════════════════════════
function docToMarkdown(doc) {
  const lines = [];
  for (const el of doc.getBodyElements()) {
    if (el.type === 'table') {
      // 表格渲染为 Markdown 表格
      const rows = [];
      for (let r = 0; ; r++) {
        const row = el.getRow(r);
        if (!row) break;
        const cells = [];
        for (let c = 0; ; c++) {
          const cell = row.getCell(c);
          if (!cell) break;
          const text = (cell.getParagraphs() ?? [])
            .map(p => p.getText?.() ?? '').join(' ').replace(/\|/g, '\\|');
          cells.push(text);
        }
        rows.push('| ' + cells.join(' | ') + ' |');
        if (r === 0) rows.push('|' + cells.map(() => '---').join('|') + '|');
      }
      if (rows.length > 1) lines.push(rows.join('\n'));
    } else {
      // 段落：提取文本，保留粗体/斜体标记
      const para = el;
      const parts = (para.getTextRuns?.() ?? [para]).map(run => {
        let text = run.text ?? run.getText?.() ?? '';
        if (!text) return '';
        if (run.bold) text = `**${text}**`;
        if (run.italic) text = `*${text}*`;
        return text;
      });
      lines.push(parts.join(''));
    }
  }
  return lines.join('\n');
}
```

### 2.3 `introspect()` — API 自发现引擎

这是核心创新：**运行时反射 docxmlater 的原型链，Agent 永远能看到最新的方法列表。**

```javascript
function introspect(target) {
  // 创建一个最小文档实例用于反射
  const doc = Document.create();
  const para = doc.createParagraph();
  const table = doc.createTable(1, 1);
  const cell = table.getRow(0).getCell(0);

  const subjects = {
    Document: doc,
    Paragraph: para,
    Table: table,
    TableRow: table.getRow(0),
    TableCell: cell,
  };

  if (target) {
    return formatAPI(target, subjects[target]);
  }

  // 无参数：列出所有可探查的类型
  return Object.keys(subjects).map(k => `  ${k}`).join('\n');
}

function formatAPI(name, instance) {
  const proto = Object.getPrototypeOf(instance);
  const methods = Object.getOwnPropertyNames(proto)
    .filter(n => n !== 'constructor' && typeof proto[n] === 'function')
    .sort();

  // 同样检查父级原型链上的方法
  let parent = Object.getPrototypeOf(proto);
  const inherited = [];
  while (parent && parent.constructor !== Object) {
    Object.getOwnPropertyNames(parent)
      .filter(n => n !== 'constructor' && typeof parent[n] === 'function' && !methods.includes(n))
      .forEach(n => inherited.push(n));
    parent = Object.getPrototypeOf(parent);
  }

  let output = `## ${name}\n\n### Own methods\n`;
  for (const m of methods) output += `- \`${m}()\`\n`;

  if (inherited.length > 0) {
    output += `\n### Inherited\n`;
    for (const m of inherited) output += `- \`${m}()\`\n`;
  }

  doc.dispose();
  return output;
}
```

**Agent 使用示例：**

```
Agent 想操作表格但不清楚方法名 → 调 shell:
  node .../docx-helper.mjs --api Table

→ 输出:
  ## Table
  ### Own methods
  - addRow()
  - addSummaryRow()
  - clone()
  - duplicateRow()
  - getRow()
  - removeEmptyColumns()
  - removeEmptyRows()
  - setBorders()
  - setWidth()
  - sortRows()
  - transpose()

Agent 看到方法列表 → 当场写代码 → 调 --run 执行
```

---

## 3. Skill 设计

```
skills/word-document/
├── SKILL.md                    # Agent 指令（~180 行）
└── scripts/
    └── docx-helper.mjs         # CLI 脚本（~120 行）
```

### 3.1 SKILL.md

```markdown
---
name: Word Document
description: 读取、创建和编辑 Word (.docx) 文档
triggers: Word文档, Word 文档, word文档, word 文档, docx
allowed-tools:
  - shell
---

## 工作流

编辑文档三步：
1. 读取：`node <skill_dir>/scripts/docx-helper.mjs --read <文件>`
2. 分析返回的 Markdown 内容，确定要做的修改
3. 执行：`node <skill_dir>/scripts/docx-helper.mjs --run --input in.docx --output out.docx -c '代码'`

创建文档：直接用 `--run`（不带 `--input`），此时 `doc = Document.create()`。
```
node <skill_dir>/scripts/docx-helper.mjs --run --output new.docx -c '
  doc.addHeading("文档标题", 1);
  doc.createParagraph().addText("正文内容", { fontSize: 12 });
  const t = doc.createTable(3, 2);
  t.getRow(0).getCell(0).createParagraph().addText("列A");
  t.getRow(0).getCell(1).createParagraph().addText("列B");
'
```

## API 发现

当下面「常用模式」没有你需要的操作时，调用 `--api` 在运行时探查可用方法：
- `--api` — 列出所有可探查的类型
- `--api Document` — 列出 Document 的全部方法
- `--api Table` — 列出 Table 的全部方法
- `--api Paragraph` — 列出 Paragraph 的全部方法
- `--api TableCell` — 列出 TableCell 的全部方法

先查 API，再写代码。不要猜方法名。

## 常用模式

以下代码片段可直接复制粘贴到 `-c` 参数中。每个示例展示一个完整功能，可多段组合使用。

### 创建和编辑的基本模式
```
// 编辑已有文档：--run --input in.docx --output out.docx -c
//   脚本已调用 Document.load()，代码中 doc 即为已加载的文档
// 创建新文档：--run --output new.docx -c
//   脚本已调用 Document.create()，代码中 doc 即为空文档

doc.createParagraph().addText('文档标题', { bold: true, fontSize: 22 });
```

### 文本搜索替换
```
doc.replaceText(/旧文本/g, '新文本');
doc.replaceText(/甲方/g, '乙方');
doc.replaceText(/\\d{4}-\\d{2}-\\d{2}/g, '2026-07-21');  // 日期格式统一
```

### 段落操作
```
// 末尾追加段落
doc.createParagraph().addText('追加的内容');
doc.createParagraph().addText('**加粗** *斜体*');
```
```
// 在指定位置插入段落
const els = doc.getBodyElements();
const ref = els[2];  // 第3个元素
const newPara = doc.createParagraph().addText('插入的段落');
doc.insertBefore(ref, newPara);
```
```
// 删除指定位置的段落
const els = doc.getBodyElements();
doc.removeElement(els[0]);  // 删除第一个元素
```
```
// 替换段落内容
const els = doc.getBodyElements();
const newPara = doc.createParagraph().addText('新内容');
doc.replaceElement(els[0], newPara);
```

### 表格操作
```
// 获取所有表格
const tables = doc.getBodyElements().filter(e => e.type === 'table');
const t = tables[0];  // 第一个表格
```
```
// 读取表格
const t = doc.getBodyElements().filter(e => e.type === 'table')[0];
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
// 添加行
const t = doc.getBodyElements().filter(e => e.type === 'table')[0];
const newRow = t.addRow();
newRow.getCell(0).createParagraph().addText('列1');
newRow.getCell(1).createParagraph().addText('列2');
newRow.getCell(2).createParagraph().addText('列3');
```
```
// 删除行
const t = doc.getBodyElements().filter(e => e.type === 'table')[0];
const row3 = t.getRow(2);  // 第3行（0-indexed）
doc.removeElement(row3);
```
```
// 编辑单元格
const t = doc.getBodyElements().filter(e => e.type === 'table')[0];
const cell = t.getRow(1).getCell(0);
const oldPara = cell.getParagraphs()[0];
const newPara = cell.createParagraph().addText('新内容');
doc.replaceElement(oldPara, newPara);
```
```
// 合并单元格（水平）
const t = doc.getBodyElements().filter(e => e.type === 'table')[0];
t.getRow(0).getCell(0).setHorizontalMerge(0, 2);  // 第1行，合并列0-2
```
```
// 合并单元格（垂直）
const t = doc.getBodyElements().filter(e => e.type === 'table')[0];
t.getRow(0).getCell(0).setVerticalMerge(0, 2);  // 第1列，合并行0-2
```
```
// 表格排序（按第1列升序）
const t = doc.getBodyElements().filter(e => e.type === 'table')[0];
t.sortRows(0, true);
```
```
// 设置表格边框
const t = doc.getBodyElements().filter(e => e.type === 'table')[0];
t.setBorders({
  top: { style: 'single', size: 4, color: '000000' },
  bottom: { style: 'single', size: 4, color: '000000' },
  left: { style: 'single', size: 4, color: '000000' },
  right: { style: 'single', size: 4, color: '000000' },
});
```

### 格式设置
```
// 搜索并加粗
doc.findAndFormat('关键词', { bold: true });
```
```
// 搜索并设置字体/颜色
doc.findAndFormat('关键词', { bold: true, italic: true, fontSize: 16, fontName: 'SimHei', color: '#FF0000' });
```
```
// 高亮文本
doc.findAndHighlight('重要', 'yellow');  // yellow, green, cyan, red
```
```
// 全文统一字体
doc.setAllRunsFont('SimSun');
doc.setAllRunsSize(12);
doc.setAllRunsColor('333333');
```
```
// 添加标题
doc.addHeading('第一章 概述', 1);  // 1-6 级标题
```

### 列表
```
// 项目符号列表
doc.addBulletListFromArray(['事项一', '事项二', '事项三']);
```
```
// 编号列表
doc.addNumberedListFromArray(['第一步', '第二步', '第三步']);
```

### 图片
```
// 在段落末尾插入图片
const para = doc.getBodyElements()[0];
const buf = await fs.readFile('chart.png');
await para.addImage(buf, { width: 400, height: 300 });
```

### 超链接
```
// 批量更新链接
doc.updateHyperlinkUrls('http://old.example.com', 'https://new.example.com');
```

### 脚注/尾注
```
const para = doc.getBodyElements()[5];
doc.createFootnote(para, '这是脚注说明');
doc.createEndnote(para, '这是尾注引用来源');
```
```
doc.clearFootnotes();
doc.clearEndnotes();
```

### 模板填充
```
doc.fillTemplate({ name: '张三', date: '2026-07-21', amount: '10,000' });
// 替换文档中所有的 {{name}}, {{date}}, {{amount}} 占位符
```

### 页面布局
```
// 这些 API 如果常用模式里没有 → 调 --api Document 查
// 然后直接在 -c 代码里调用
```

## 代码规范

- 代码中可访问注入的变量：`doc`、`console`、`fs`、`path`
  - `doc` — 已加载的 docxmlater Document 实例（`--run --input` 时调用 `Document.load()`，无 `--input` 时调用 `Document.create()`）
  - `console` — 输出日志到 Agent 可见的 stdout（console.error 也可见）
  - `fs` — Node.js `fs/promises` 模块（异步文件操作：`await fs.readFile()` 等）
  - `path` — Node.js `path` 模块
- **不要调用 `doc.save()` 或 `doc.dispose()`**——脚本在代码执行后自动处理
- 如果代码执行失败，错误信息和堆栈会输出到 stderr。根据错误修正，不要放弃
- `<skill_dir>` 替换为 skill 的实际安装路径
```

---

## 4. Agent 工作流示例

### 场景：用户发来一份周报 docx，要求改标题加一行表格

```
1. Agent 调 shell 读取文档:
   node skills/word-document/scripts/docx-helper.mjs --read weekly.docx

2. 脚本输出 Markdown 内容，Agent 分析：
   - 第一段是标题 "上周工作总结"
   - 有一个 4 行的表格

3. Agent 从 SKILL.md「常用模式」中找到对应的代码片段，直接复制拼接：
   - 文本替换 → 复制「文本搜索替换」片段
   - 加粗 → 复制「搜索并加粗」片段
   - 添加表格行 → 复制「表格操作 > 添加行」片段

4. Agent 拼好代码，调 shell 执行:
   node skills/word-document/scripts/docx-helper.mjs --run --input weekly.docx --output weekly.docx -c '
     doc.replaceText(/上周工作总结/g, "本周工作总结");
     doc.findAndFormat("项目A", { bold: true });
     const t = doc.getBodyElements().filter(e => e.type === "table")[0];
     const newRow = t.addRow();
     newRow.getCell(0).createParagraph().addText("项目B");
     newRow.getCell(1).createParagraph().addText("待开始");
     newRow.getCell(2).createParagraph().addText("0%");
   '

5. 脚本执行成功 → 返回 SAVED: weekly.docx
   // 全程没有调用 --api，因为 SKILL.md 已经覆盖了所需操作
```

---

## 5. 项目改动清单

```
零文件修改 + 两个新文件
├── skills/word-document/
│   ├── SKILL.md              # 新增（~180 行，含常用代码片段）
│   └── scripts/
│       └── docx-helper.mjs    # 新增（~170 行，含自安装 + docToMarkdown）
└── （无需修改任何现有文件）
```

npm 依赖：`docxmlater`（脚本首次运行自动通过 `pnpm add` 安装，无需用户手动操作。仅 `jszip` 一个传递依赖，Termux 兼容）。

---

## 6. 与 ToolDefinition 方案的深度对比

### 6.1 新 API 的响应速度

| 场景 | ToolDefinition | 纯 Skill + 脚本 |
|------|-------------|----------------|
| docxmlater 发了 v13，新增 `doc.insertChart()` | 开发者需：读 changelog → 加 schema 字段 → 写 engine 封装 → 写测试 → 发版。Agent 在此期间**不可用** | Agent 调 `--api Document` → 看到 `insertChart()` → 当场写 `doc.insertChart(...)` → **立即可用** |

### 6.2 Token 效率

| 操作 | ToolDefinition token | Skill + 脚本 token |
|------|---------------------|-------------------|
| 替换 1 处文本 | ~200 tokens（JSON 参数） | ~250 tokens（shell + 代码片段，SKILL.md 里有现成的） |
| 复杂表格操作（5 步） | ~500 tokens | ~600 tokens（SKILL.md 直接复制拼装） |
| 冷门 API（如 `doc.validateNumberingReferences()`） | 不可用（等发版） | 先 `--api Document`（~200 tokens）然后写代码（~200 tokens）立刻用 |
| SKILL.md 里没有的 docxmlater v13 新 API | 不可用 | `--api` 立即发现，立即可用 |

Token 差距在 20%-30%，但对于 Agent 自主探索带来的灵活性而言，这个代价是值得的。

### 6.3 安全模型

两种方案最终都经过 `shell` 工具执行，安全边界一致。脚本不引入新的权限模型。

### 6.4 可测试性

| 测试维度 | ToolDefinition | 纯 Skill + 脚本 |
|----------|---------------|----------------|
| 单元测试 | 容易（纯函数） | 中等（需 mock Document） |
| 集成测试 | 需启动 Agent 环境 | 直接调脚本 CLI |
| API 发现测试 | 不需要（固定 schema） | 需测试 introspect 输出正确性 |

---

## 7. 纯脚本方案的局限性

| 局限 | 影响 | 缓解 |
|------|------|------|
| Agent 写错代码会抛异常 | 需要多轮对话调试 | 错误信息包含堆栈，Agent 自我修正能力强 |
| shell 工具的输出截断 | 长文档可能被截断 | `--read` 默认截断到 50000 字符；大文档建议分次读取 |
| 类型安全缺失 | 参数错误运行时才发现 | `--api` 提供方法名，减少拼写错误 |
| 没有 TypeBox 参数校验 | 无效参数传到 docxmlater 才报错 | Agent 从错误中学习，下次不再犯 |
| PolicyCenter 无法单独控制 docx 操作 | 权限管控粒度粗（走 shell 共用的 policy） | 如需精细控制，可后续加一个简单的 tool wrapper |

---

## 8. 实施步骤

1. 创建 `skills/word-document/scripts/docx-helper.mjs`（约 170 行）
2. 创建 `skills/word-document/SKILL.md`（约 180 行）
3. 终端验证（首次运行会自动安装 docxmlater）：
   ```bash
   node skills/word-document/scripts/docx-helper.mjs --api
   node skills/word-document/scripts/docx-helper.mjs --api Document
   node skills/word-document/scripts/docx-helper.mjs --run -c '
     const doc = Document.create();
     doc.createParagraph().addText("Hello from Agent", { bold: true, fontSize: 24 });
     await doc.save("/tmp/test.docx");
   '
   node skills/word-document/scripts/docx-helper.mjs --read /tmp/test.docx
   ```
5. 通过 Agent 端到端测试：发送飞书消息 → Skill 激活 → Agent 调 shell → 返回结果

---

## 9. 实施记录（2026-07-21）

实施过程中发现并修正的设计偏差：

### 实际文件规模

| 文件 | 设计预估 | 实际 |
|------|---------|------|
| `docx-helper.mjs` | ~170 行 | 189 行 |
| `SKILL.md` | ~180 行 | ~340 行（含大量已验证的代码片段） |

### API 差异清单

实施阶段通过实际运行 docxmlater v12.1.0 验证每个 API，与设计时的文档推断存在以下差异：

| 设计假设 | 实际行为 | 说明 |
|---------|---------|------|
| `el.type === 'table'` | `el.constructor.name === 'Table'` | `type` 属性不存在于 body element 上；需用 constructor 名称判定 |
| `para.getTextRuns()` | `para.getRuns()` | 方法名不同。返回 `Run[]` 对象数组 |
| `run.bold` / `run.italic` | `run.formatting.bold` / `run.formatting.italic` | 格式选项嵌套在 `formatting` 对象内，非 Run 的直接属性 |
| `doc.replaceText(/regex/g, ...)` | `doc.replaceText("string", ...)` | 仅支持字符串字面量，不支持正则表达式。一次调用替换文档中所有匹配项 |
| `para.addImage(buf, opts)` | `new Image({ source: buf, ... })` → `doc.addImage(img)` | 图片通过 `Document.addImage()` 整体添加，而非通过段落方法。`Image` 类需注入到 Agent 代码作用域 |
| `AsyncFunction` 全局可用 | 需手动获取：`Object.getPrototypeOf(async () => {}).constructor` | Node.js 无 `AsyncFunction` 全局 |
| `t.addRow()` | `t.addRowFromArray([...])` / `t.createRow()` | `addRow()` 存在内部 `_setParentTable` bug（v12.1.0），需用 `addRowFromArray` 或 `createRow` 替代 |
| `doc.showRevisions()` / `doc.acceptAllChanges()` 作为运行时方法 | `revisionHandling` 是 `Document.load()` 的加载时选项 | 修订控制仅在加载时生效，无独立的运行时 API（设计文档已正确标注） |
| `--api <type>` 输出不区分 Own/Inherited | prototype chain walk 正确处理 | 额外爬取父级原型链上的继承方法并独立展示 |

### 已验证通过的 API（端到端）

以下操作通过完整的 `--run` → `--read` 工作流验证：

- `doc.createParagraph().addText(text, formatting)` — 段落创建与格式
- `doc.addHeading(text, level)` — 标题（1-6 级）
- `doc.addBulletListFromArray(arr)` / `doc.addNumberedListFromArray(arr)` — 列表
- `doc.replaceText(old, new)` — 全文字符串替换
- `doc.findAndFormat(text, formatting)` — 搜索并格式化
- `doc.findAndHighlight(text, color)` — 搜索并高亮
- `doc.setAllRunsFont/setAllRunsSize/setAllRunsColor` — 全文格式统一
- `doc.fillTemplate({ key: val })` — 模板占位符填充
- `doc.createTable(rows, cols)` + 表格边框/读取/排序/单元格合并
- `t.addRowFromArray([...])` / `t.createRow()` — 表格行添加
- `doc.removeElement(el)` — 元素删除
- `doc.replaceElement(old, new)` — 元素替换
- `doc.insertBefore(ref, newEl)` — 指定位置插入
- `doc.createFootnote(para, text)` / `doc.createEndnote(para, text)` — 脚注/尾注
- `doc.clearFootnotes()` / `doc.clearEndnotes()` — 清除脚注/尾注
- `doc.updateHyperlinkUrls(old, new)` — 超链接批量更新
- `doc.addImage(new Image({ source: buf, ... }))` — 图片插入
- `--api` / `--api <Type>` — API 自发现（Document 输出 460+ 方法，Table 输出 76+ 方法）
- `--read` → 结构化 Markdown（粗体→`**text**`，斜体→`*text*`，表格→GFM）

### 注入变量扩展

原设计仅注入 `doc`, `console`, `fs`, `path`。实际增加了 `Image`, `ImageRun`，因为图片操作需要 `Image` 类实例化。脚本从 docxmlater 同时解构 `Table`, `TableRow`, `TableCell`, `Paragraph`, `Run`（虽然在 introspection 中使用，注入给 Agent 的仅 `Image` 和 `ImageRun`）。

### SKILL.md 微调

- `<skill_dir>` 占位符替换为硬编码 `skills/word-document`——当前 Skill 系统无模板变量替换，Agent 依赖自身理解路径的方案脆弱，直接使用相对路径更可靠
- `replaceText` 注释从「每次一处」修正为「替换所有匹配项」
- 表格添加行提供两种方式：`addRowFromArray`（简单）和 `createRow`（复杂格式）

---

## 10. 参考资料

- docxmlater npm: https://www.npmjs.com/package/docxmlater
- OhMyAgent Skill 加载器: `src/skills/skill-loader.ts`（`scanResources` 扫描 `scripts/` 目录）
- OhMyAgent shell 工具: `src/tools/builtins/shell/definition.ts`
