# DOCX 工具设计文档

## 1. 概述

为 OhMyAgent 增加 `.docx`（Microsoft Word）文档的读取、创建和编辑能力，基于 **docxmlater**（v12.1.0, MIT 许可）纯 TypeScript 库实现。

### 1.1 动机

当前项目的 `file_read` / `file_write` / `file_edit` 工具只能操作纯文本文件。增加 DOCX 能力后，Agent 可以：
- 读取用户发送的 Word 文档内容
- 按模板生成格式化的 .docx 报告、合同、周报
- 编辑已有文档的文本、表格、样式

### 1.2 为什么选 docxmlater

| 对比维度 | docxmlater | python-docx (sidecar) | @aspose/words | office-oxide |
|---------|-----------|----------------------|---------------|-------------|
| 许可 | MIT | MIT | 商业 | MIT/Apache2 |
| 运行时 | 纯 TS (仅依赖 jszip) | 需要 Python | .NET 桥接 | Rust 原生 |
| Termux 兼容 | ✅ | ✅ (pkg install python) | ❌ | ⚠️ 需预编译二进制 |
| 读取已有文档 | ✅ | ✅ | ✅ | ✅ |
| 创建新文档 | ✅ | ✅ | ✅ | ❌ |
| 表格增删改 | ✅ (getRow + removeElement) | ✅ | ✅ | ❌ (仅 replaceText) |
| 合并单元格 | ✅ | ✅ | ✅ | ❌ |
| 跟踪修订保留 | ✅ (round-trip) | ⚠️ 部分丢失 | ✅ | ✅ |
| 社区成熟度 | 小众 (134周下载) | 成熟 | 企业级 | 早期 (v0.1.3) |

docxmlater 是唯一同时满足 **MIT 许可 + 纯 Node.js + 可编辑现有文档含表格操作** 的库。

---

## 2. 工具设计

遵循项目现有的 v4 ToolDefinition 模式，新增 3 个工具，与现有 `file_read` / `file_write` / `file_edit` 三件套对齐：

| 工具名 | 对标 | 用途 |
|--------|------|------|
| `docx_read` | `file_read` | 读取 .docx 文档，返回结构化的文本和表格内容 |
| `docx_create` | `file_write` | 从结构化描述创建新的 .docx 文档 |
| `docx_edit` | `file_edit` | 编辑已有 .docx（13 个操作组：文本、段落、表格、格式、列表、图片、超链接、页眉页脚、脚注、分节、批注、修订、页面布局） |

### 2.0 能力总览

`docx_edit` 的 13 个操作组覆盖 docxmlater 的全部编辑能力：

| # | 操作组 | 用途 | 典型场景 |
|---|--------|------|---------|
| 1 | `replacements` | 全文搜索替换（支持正则） | 统一修改人名、日期格式、术语 |
| 2 | `paragraphs` | 增删改段落 | 插入缺失章节、删除冗余内容、重写段落 |
| 3 | `tableOperations` | 表格结构编辑 | 增删行列、编辑单元格、合并单元格、排序 |
| 4 | `formatting` | 文本和段落格式 | 设标题级别、改字体/大小/颜色、高亮、对齐、行距、首行缩进 |
| 5 | `lists` | 列表创建与编号控制 | 创建项目符号/编号列表、重新开始编号 |
| 6 | `images` | 图片操作 | 插入图片、删除图片、设置文字环绕 |
| 7 | `hyperlinks` | 超链接管理 | 添加链接、批量更新 URL、移除链接 |
| 8 | `headersFooters` | 页眉页脚 | 设置页眉文字、插入页码、首页不同、奇偶页不同 |
| 9 | `footnotes` | 脚注和尾注 | 添加脚注/尾注、清除全部脚注/尾注 |
| 10 | `sections` | 分节管理 | 插入分节符、每节独立页面方向和页边距 |
| 11 | `comments` | 批注管理 | 添加审阅意见、回复批注、删除已处理批注 |
| 12 | `trackChanges` | 修订控制 | 一键接受或拒绝所有修订标记 |
| 13 | `pageSetup` | 文档级页面布局 | 默认纸张方向、页边距、纸张大小 |

### 2.1 工具详细规格

#### 2.1.1 `docx_read` — 读取 DOCX 文档

```
名称:       docx_read
分类:       file
路径权限:    read
读写标记:    readOnly=true, readsFiles=true, writesFiles=false
审批默认:    none
```

**参数 (TypeBox)：**

```typescript
Type.Object({
  filePath: Type.String({ description: '要读取的 .docx 文件路径' }),
  includeTables: Type.Optional(Type.Boolean({
    description: '是否包含表格内容，默认 true',
    default: true,
  })),
  maxLength: Type.Optional(Type.Number({
    description: '最大返回字符数，默认 50000',
    default: 50000,
  })),
})
```

**返回格式：**

以结构化 Markdown 返回文档内容：
- 段落文本保留原有换行
- 表格渲染为 Markdown 表格语法（`| cell | cell |`）
- 超过 `maxLength` 时截断并提示

**核心实现逻辑：**

```
Document.load(filePath)
  → 遍历 body 子元素
    → Paragraph → 提取文本，保留格式标记（加粗=**text**，斜体=*text*）
    → Table → getRow(i) → getCell(j) → 提取文本 → 渲染 Markdown 表格
  → 拼接并截断返回
  → doc.dispose()
```

#### 2.1.2 `docx_create` — 创建 DOCX 文档

```
名称:       docx_create
分类:       file
路径权限:    write
读写标记:    readOnly=false, readsFiles=false, writesFiles=true
审批默认:    none
```

**参数：**

```typescript
Type.Object({
  filePath: Type.String({ description: '输出 .docx 文件路径' }),
  content: Type.String({
    description: '文档内容，支持 Markdown 语法。' +
      '支持的 Markdown 元素：' +
      '# 标题（1-6级）、**加粗**、*斜体*、- 无序列表、1. 有序列表、' +
      '| 表格 | 语法 |、--- 分隔线、普通段落',
  }),
  title: Type.Optional(Type.String({ description: '文档标题（显示在 Word 属性中）' })),
})
```

**核心实现逻辑：**

```
Document.create()
  → parseMarkdown(content) 解析为 docxmlater 元素序列
    → # Heading → doc.createParagraph() + 设置标题样式
    → **bold** → addText(text, { bold: true })
    → | table | → doc.createTable(rows, cols) + 填充单元格
    → 普通文本 → doc.createParagraph().addText(text)
  → 如果 title 存在，设置文档元数据
  → doc.save(filePath)
  → doc.dispose()
```

#### 2.1.3 `docx_edit` — 编辑 DOCX 文档

```
名称:       docx_edit
分类:       file
路径权限:    read_write
读写标记:    readOnly=false, readsFiles=true, writesFiles=true
审批默认:    none
```

**设计原则：** 所有编辑操作分组为独立的可选参数，一次调用只传需要的操作组。工具内部先执行 13 组声明式操作，再执行 `customCode`（如果提供），最后统一保存。声明式操作执行顺序：文本替换 → 段落 → 表格 → 格式 → 列表 → 图片 → 超链接 → 页眉页脚 → 脚注 → 分节 → 批注 → 修订 → 页面布局。每个操作组的结果在返回摘要中逐一报告。

> **API 验证状态：** 每个操作组末尾标注了底层 docxmlater API 的确认状态（✅ 已确认 / ⚠️ 部分待验证 / 🔧 需 customCode）。详见附录 A。

**参数：**

```typescript
Type.Object({
  filePath: Type.String({ description: '要编辑的 .docx 文件路径' }),

  // ── 1. 文本替换 ──
  replacements: Type.Optional(Type.Array(Type.Object({
    search: Type.String({ description: '要搜索的文本（支持正则表达式字符串）' }),
    replace: Type.String({ description: '替换为的文本' }),
    flags: Type.Optional(Type.String({ description: '正则标志，如 "gi"', default: 'g' })),
  }))),

  // ── 2. 段落操作 ──
  paragraphs: Type.Optional(Type.Array(Type.Object({
    action: Type.Enum(['insert', 'delete', 'edit'], {
      description: 'insert=在指定位置插入新段落, delete=删除段落, edit=替换段落文本',
    }),
    index: Type.Number({ description: '段落索引（从 0 开始）。insert 时光标后的段落会后移；-1 表示文档末尾' }),
    text: Type.Optional(Type.String({ description: '段落文本（insert/edit 使用）。支持 Markdown 内联格式：**加粗** *斜体*' })),
    style: Type.Optional(Type.Enum(['normal', 'heading1', 'heading2', 'heading3'], {
      description: '段落样式。默认 normal',
      default: 'normal',
    })),
  }))),

  // ── 3. 表格操作 ──
  tableOperations: Type.Optional(Type.Array(Type.Object({
    tableIndex: Type.Number({ description: '表格索引（从 0 开始）' }),
    action: Type.Enum([
      'deleteRow', 'addRow', 'editCell', 'mergeCells', 'setBorders',
      'sortRows', 'addColumn', 'deleteColumn',
    ], { description: '操作类型' }),
    // 行/列定位
    rowIndex: Type.Optional(Type.Number({ description: '行索引（从 0 开始）。deleteRow/editCell/addRow/deleteColumn 使用' })),
    colIndex: Type.Optional(Type.Number({ description: '列索引（从 0 开始）。editCell/addColumn 使用' })),
    // addRow
    cells: Type.Optional(Type.Array(Type.String(), { description: '新行的单元格文本数组（addRow 使用）' })),
    // addColumn
    columnCells: Type.Optional(Type.Array(Type.String(), { description: '新列的单元格文本数组（addColumn 使用）' })),
    // editCell
    newText: Type.Optional(Type.String({ description: '单元格新文本（editCell 使用）' })),
    // mergeCells
    endRowIndex: Type.Optional(Type.Number({ description: '合并结束行（mergeCells 使用）' })),
    endColIndex: Type.Optional(Type.Number({ description: '合并结束列（mergeCells 使用）' })),
    mergeDirection: Type.Optional(Type.Enum(['horizontal', 'vertical'], { description: '合并方向' })),
    // setBorders
    borderStyle: Type.Optional(Type.String({ description: '边框样式：single, double, dashed, none' })),
    // sortRows
    sortByColumn: Type.Optional(Type.Number({ description: '按哪一列排序（sortRows 使用）' })),
    sortAscending: Type.Optional(Type.Boolean({ description: '是否升序', default: true })),
  }))),

  // ── 4. 格式设置 ──
  formatting: Type.Optional(Type.Array(Type.Object({
    target: Type.Enum(['heading', 'text', 'paragraph'], {
      description: '格式作用目标：heading=设置标题级别, text=内联文本格式, paragraph=段落级格式',
    }),
    // heading
    paragraphIndex: Type.Optional(Type.Number({ description: '段落索引。heading/paragraph 使用' })),
    level: Type.Optional(Type.Number({ description: '标题级别 1-6（target=heading 使用）' })),
    // text
    search: Type.Optional(Type.String({ description: '要格式化的文本匹配（target=text 使用）' })),
    // 格式属性（text 和 paragraph 共用）
    bold: Type.Optional(Type.Boolean({ description: '加粗' })),
    italic: Type.Optional(Type.Boolean({ description: '斜体' })),
    underline: Type.Optional(Type.Boolean({ description: '下划线' })),
    fontSize: Type.Optional(Type.Number({ description: '字体大小（磅）' })),
    fontName: Type.Optional(Type.String({ description: '字体名称，如 "SimSun"（宋体）、"SimHei"（黑体）' })),
    color: Type.Optional(Type.String({ description: '字体颜色，如 "#FF0000"' })),
    highlight: Type.Optional(Type.String({ description: '高亮颜色：yellow, green, cyan, red, none' })),
    alignment: Type.Optional(Type.Enum(['left', 'center', 'right', 'justify'], { description: '段落对齐方式' })),
    lineSpacing: Type.Optional(Type.Number({ description: '行距倍数，如 1.5' })),
    firstLineIndent: Type.Optional(Type.Number({ description: '首行缩进（字符数），如 2 表示两个字符' })),
  }))),

  // ── 5. 列表操作 ──
  lists: Type.Optional(Type.Array(Type.Object({
    action: Type.Enum(['createBullet', 'createNumbered', 'restartNumbering'], {
      description: 'createBullet=创建项目符号列表, createNumbered=创建编号列表, restartNumbering=重新开始编号',
    }),
    items: Type.Optional(Type.Array(Type.String(), { description: '列表项文本数组（createBullet/createNumbered 使用）' })),
    numberFormat: Type.Optional(Type.Enum(['decimal', 'roman', 'alpha'], {
      description: '编号格式（createNumbered 使用）。默认 decimal',
      default: 'decimal',
    })),
    paragraphIndex: Type.Optional(Type.Number({ description: '重新开始编号的段落索引（restartNumbering 使用）' })),
    startValue: Type.Optional(Type.Number({ description: '重新编号的起始值，默认 1', default: 1 })),
  }))),

  // ── 6. 图片操作 ──
  images: Type.Optional(Type.Array(Type.Object({
    action: Type.Enum(['insert', 'delete'], { description: 'insert=插入图片, delete=删除图片' }),
    imagePath: Type.Optional(Type.String({ description: '图片文件路径（insert 使用）。支持 PNG/JPEG/GIF/SVG/BMP' })),
    // insert
    position: Type.Optional(Type.Enum(['after', 'before'], {
      description: '插入位置：after/before 指定段落。默认 after',
      default: 'after',
    })),
    paragraphIndex: Type.Optional(Type.Number({ description: '锚定段落索引（insert/delete 使用）' })),
    width: Type.Optional(Type.Number({ description: '图片宽度（像素），不传则保持原始尺寸' })),
    height: Type.Optional(Type.Number({ description: '图片高度（像素），不传则保持原始尺寸' })),
    textWrapping: Type.Optional(Type.Enum(['inline', 'square', 'tight', 'topBottom', 'behind', 'front'], {
      description: '文字环绕方式。默认 inline',
    })),
    // delete
    imageIndex: Type.Optional(Type.Number({ description: '要删除的图片索引（delete 使用，从 0 开始）' })),
  }))),

  // ── 7. 超链接管理 ──
  hyperlinks: Type.Optional(Type.Array(Type.Object({
    action: Type.Enum(['add', 'update', 'remove'], { description: 'add=添加超链接, update=更新URL, remove=移除超链接' }),
    text: Type.Optional(Type.String({ description: '要添加超链接的文本（add 使用）。匹配到的第一处' })),
    url: Type.Optional(Type.String({ description: '链接 URL（add/update 使用）' })),
    oldUrl: Type.Optional(Type.String({ description: '要更新的旧 URL（update 使用）。会批量更新所有匹配项' })),
    // remove
    removeFromText: Type.Optional(Type.String({ description: '从此文本上移除超链接（remove 使用）' })),
  }))),

  // ── 8. 页眉页脚 ──
  headersFooters: Type.Optional(Type.Object({
    header: Type.Optional(Type.Object({
      text: Type.Optional(Type.String({ description: '页眉文字' })),
      alignment: Type.Optional(Type.Enum(['left', 'center', 'right'], { description: '页眉对齐，默认 center' })),
      includePageNumber: Type.Optional(Type.Boolean({ description: '是否包含页码，默认 false' })),
      pageNumberFormat: Type.Optional(Type.Enum(['number', 'roman'], { description: '页码格式' })),
      pageNumberPosition: Type.Optional(Type.Enum(['left', 'center', 'right'], { description: '页码位置' })),
    })),
    footer: Type.Optional(Type.Object({
      text: Type.Optional(Type.String({ description: '页脚文字' })),
      alignment: Type.Optional(Type.Enum(['left', 'center', 'right'], { description: '页脚对齐，默认 center' })),
      includePageNumber: Type.Optional(Type.Boolean({ description: '是否包含页码' })),
      pageNumberFormat: Type.Optional(Type.Enum(['number', 'roman'], { description: '页码格式' })),
      pageNumberPosition: Type.Optional(Type.Enum(['left', 'center', 'right'], { description: '页码位置' })),
    })),
    differentFirstPage: Type.Optional(Type.Boolean({ description: '首页不同' })),
    differentOddEven: Type.Optional(Type.Boolean({ description: '奇偶页不同' })),
  })),

  // ── 9. 脚注和尾注 ──
  footnotes: Type.Optional(Type.Array(Type.Object({
    action: Type.Enum(['addFootnote', 'addEndnote', 'clearAll'], {
      description: 'addFootnote=添加脚注, addEndnote=添加尾注, clearAll=清除所有脚注和尾注',
    }),
    paragraphIndex: Type.Optional(Type.Number({ description: '脚注/尾注附着的段落索引（addFootnote/addEndnote 使用）' })),
    text: Type.Optional(Type.String({ description: '脚注/尾注文本（addFootnote/addEndnote 使用）' })),
  }))),

  // ── 10. 分节管理 ──
  sections: Type.Optional(Type.Array(Type.Object({
    action: Type.Enum(['insertBreak', 'setLayout'], {
      description: 'insertBreak=在指定段落前插入分节符, setLayout=设置指定节的页面布局',
    }),
    paragraphIndex: Type.Optional(Type.Number({ description: '在此段落前插入分节符（insertBreak 使用）' })),
    breakType: Type.Optional(Type.Enum(['nextPage', 'continuous', 'evenPage', 'oddPage'], {
      description: '分节符类型。默认 nextPage',
      default: 'nextPage',
    })),
    sectionIndex: Type.Optional(Type.Number({ description: '节索引（setLayout 使用，从 0 开始）' })),
    orientation: Type.Optional(Type.Enum(['portrait', 'landscape'], { description: '该节的纸张方向' })),
    marginTop: Type.Optional(Type.Number({ description: '该节的上边距（毫米）' })),
    marginBottom: Type.Optional(Type.Number({ description: '该节的下边距（毫米）' })),
    marginLeft: Type.Optional(Type.Number({ description: '该节的左边距（毫米）' })),
    marginRight: Type.Optional(Type.Number({ description: '该节的右边距（毫米）' })),
  }))),

  // ── 11. 批注操作 ──
  comments: Type.Optional(Type.Array(Type.Object({
    action: Type.Enum(['add', 'reply', 'delete'], { description: '批注操作类型' }),
    commentId: Type.Optional(Type.String({ description: '批注 ID（reply/delete 使用）' })),
    text: Type.Optional(Type.String({ description: '批注文本（add/reply 使用）' })),
    author: Type.Optional(Type.String({ description: '批注作者名' })),
    // add
    anchorText: Type.Optional(Type.String({ description: '要标注的文档文本，批注将锚定到第一个匹配处（add 使用）' })),
  }))),

  // ── 12. 修订控制 ──
  // ⚠️ docxmlater 的修订控制在 load time：Document.load(path, { revisionHandling })
  // 而非 runtime 方法。因此 trackChanges 通过重新加载文档实现：
  //   1. 用当前内容保存到临时文件
  //   2. 以指定的 revisionHandling 模式重新加载
  //   3. 保存回目标路径
  trackChanges: Type.Optional(Type.Object({
    action: Type.Enum(['acceptAll', 'rejectAll'], {
      description: 'acceptAll=接受所有修订（保留插入、删除批注标记）, rejectAll=拒绝所有修订（恢复原始文档、撤销所有修改）',
    }),
  })),

  // ── 13. 文档级页面布局 ──
  pageSetup: Type.Optional(Type.Object({
    orientation: Type.Optional(Type.Enum(['portrait', 'landscape'], { description: '纸张方向（默认节）' })),
    marginTop: Type.Optional(Type.Number({ description: '上边距（毫米）' })),
    marginBottom: Type.Optional(Type.Number({ description: '下边距（毫米）' })),
    marginLeft: Type.Optional(Type.Number({ description: '左边距（毫米）' })),
    marginRight: Type.Optional(Type.Number({ description: '右边距（毫米）' })),
    paperSize: Type.Optional(Type.Enum(['A4', 'A3', 'Letter', 'Legal'], { description: '纸张大小' })),
    // TOC 目录
    insertToc: Type.Optional(Type.Boolean({ description: '在文档开头插入 TOC 目录字段' })),
  })),

  // ── 通用选项 ──
  outputPath: Type.Optional(Type.String({
    description: '输出文件路径。不传则覆盖原文件（filePath）',
  })),

  // ── 逃生舱：直接调用 docxmlater API ──
  customCode: Type.Optional(Type.String({
    description:
      '自定义 TypeScript 代码片段，用于调用以上 13 组操作未覆盖的 docxmlater API。' +
      '代码中可直接使用以下已注入的变量：' +
      '`doc` — 已加载的 docxmlater Document 实例。' +
      '`fs` — Node.js fs/promises 模块。' +
      '`path` — Node.js path 模块。' +
      '不要调用 doc.save() 或 doc.dispose()，工具会自动处理保存和资源释放。' +
      '如果操作失败，抛出 Error 即可，工具会捕获并返回错误信息。' +
      '示例：`const images = doc.findImagesWithoutAltText(); doc.createParagraph().addText("发现 " + images.length + " 张图片缺少替代文本");`',
  })),
})
```

**核心实现逻辑：**

```
Document.load(filePath)
  targetPath = outputPath ?? filePath

  → 1. 文本替换
    for each replacement in (replacements ?? []):
      count += doc.replaceText(new RegExp(search, flags), replace)
    log: "完成 {count} 处文本替换"

  → 2. 段落操作
    // ⚠️ docxmlater 无 getParagraph(index)，使用 getBodyElements() 按索引定位
    bodyElements = doc.getBodyElements()
    for each op in (paragraphs ?? []):
      switch op.action:
        case 'insert':
          newPara = doc.createParagraph().addText(op.text, inlineFormatting)
          if op.index >= 0 && op.index < bodyElements.length:
            doc.insertBefore(bodyElements[op.index], newPara)
          设置段落样式(op.style)  // ⚠️ 通过 customCode 调用 XML 操作实现

        case 'delete':
          target = bodyElements[op.index]
          doc.removeElement(target)

        case 'edit':
          target = bodyElements[op.index]
          doc.replaceElement(target, doc.createParagraph().addText(op.text, inlineFormatting))

  → 3. 表格操作
    // ⚠️ docxmlater 无 getTable(index)，通过 getBodyElements() 过滤 Table 类型获取
    tables = doc.getBodyElements().filter(e => e.type === 'table')
    for each op in (tableOperations ?? []):
      table = tables[op.tableIndex]

      switch op.action:
        case 'deleteRow':
          // ✅ 已确认：getRow + removeElement
          row = table.getRow(op.rowIndex)
          doc.removeElement(row)

        case 'addRow':
          // ✅ 已确认：table.addRow() + cell.createParagraph().addText()
          newRow = table.addRow()
          for (i, text) of (op.cells ?? []):
            newRow.getCell(i).createParagraph().addText(text)

        case 'editCell':
          // ⚠️ cell.removeAllChildren() 未确认 — 用 replaceElement 替代
          cell = table.getRow(op.rowIndex).getCell(op.colIndex)
          oldPara = cell.getParagraphs()[0]
          newPara = cell.createParagraph().addText(op.newText)
          if oldPara: doc.replaceElement(oldPara, newPara)

        case 'mergeCells':
          // ✅ 已确认
          if op.mergeDirection === 'horizontal':
            table.getRow(op.rowIndex).getCell(op.colIndex).setHorizontalMerge(...)
          else:
            table.getRow(op.rowIndex).getCell(op.colIndex).setVerticalMerge(...)

        case 'setBorders':
          // ✅ 已确认
          table.setBorders({ top: { style: op.borderStyle }, bottom: { style: op.borderStyle }, ... })

        case 'sortRows':
          // ✅ 已确认
          table.sortRows(op.sortByColumn, op.sortAscending)

        case 'addColumn':
          // 🔧 复合操作：遍历每行，在每行末尾追加一个 cell
          for each row in table:
            row.getCell(row.cells.length - 1).createParagraph().addText(op.columnCells[i])

        case 'deleteColumn':
          // 🔧 复合操作：遍历每行，removeElement 目标列的 cell

  → 4. 格式设置
    // ⚠️ 段落级格式（alignment, lineSpacing, firstLineIndent）=> 🔧 customCode
    // ✅ 文本级格式确认：findAndFormat, findAndHighlight, setAllRuns*
    for each fmt in (formatting ?? []):
      switch fmt.target:
        case 'heading':
          // ⚠️ addHeading 创建新标题；给已有段落设标题级别需 customCode
          doc.addHeading(para.text, fmt.level)

        case 'text':
          if fmt.highlight:
            doc.findAndHighlight(fmt.search, fmt.highlight)
          formatProps = { bold: fmt.bold, italic: fmt.italic, underline: fmt.underline,
                          fontSize: fmt.fontSize, fontName: fmt.fontName, color: fmt.color }
          doc.findAndFormat(fmt.search, stripUndefined(formatProps))

        case 'paragraph':
          // 🔧 对齐/行距/缩进 — 通过 customCode 操作底层 XML 实现
          // 设计文档保留参数，实现阶段确认可用性

  → 5. 列表操作  ✅ 全部 API 已确认
    for each op in (lists ?? []):
      switch op.action:
        case 'createBullet':
          doc.addBulletListFromArray(op.items)
        case 'createNumbered':
          doc.addNumberedListFromArray(op.items, { format: op.numberFormat })
        case 'restartNumbering':
          doc.restartNumbering(op.numId, op.level, op.startValue)

  → 6. 图片操作  ⚠️ 仅 addImage 已确认
    for each op in (images ?? []):
      switch op.action:
        case 'insert':
          // ✅ 已确认：paragraph.addImage(buffer, { width, height, format })
          buf = await fs.readFile(op.imagePath)
          para = doc.getBodyElements()[op.paragraphIndex]
          await para.addImage(buf, { width: op.width, height: op.height })
          // ⚠️ textWrapping 未确认，保留参数但不实现

        case 'delete':
          // 🔧 未确认：无 removeImage API，通过 customCode 操作 XML

  → 7. 超链接管理  ✅ 核心 API 已确认
    for each op in (hyperlinks ?? []):
      switch op.action:
        case 'add':
          // ⚠️ addHyperlink 用法未确认 — 实现阶段验证
          para = doc.getBodyElements()[op.paragraphIndex]  // 或 findParagraphsByText
          para.addHyperlink({ text: op.text, url: op.url })

        case 'update':
          // ✅ 已确认
          doc.updateHyperlinkUrls(op.oldUrl, op.url)

        case 'remove':
          // 🔧 无 removeHyperlink API — 通过 customCode 操作 XML

  → 8. 页眉页脚  🔧 全部通过 customCode
    // docxmlater 文档声称支持 headers/footers（含首页不同、奇偶页不同）
    // 和页码字段，但未暴露具体的 getHeader/getFooter/addPageNumber 等
    // JavaScript 方法。具体 API 名称需在实现阶段查看源码确认。
    // 暂时全部通过 customCode + 底层 XML 操作实现。

  → 9. 脚注和尾注  ✅ 全部 API 已确认
    for each op in (footnotes ?? []):
      switch op.action:
        case 'addFootnote':
          doc.createFootnote(doc.getBodyElements()[op.paragraphIndex], op.text)
        case 'addEndnote':
          doc.createEndnote(doc.getBodyElements()[op.paragraphIndex], op.text)
        case 'clearAll':
          doc.clearFootnotes()
          doc.clearEndnotes()

  → 10. 分节管理  ⚠️ createSection 已确认，setLayout 🔧
    for each op in (sections ?? []):
      switch op.action:
        case 'insertBreak':
          // ⚠️ 直接 insertSectionBreak 方法名未确认
          doc.createSection()  // ✅ 已确认
        case 'setLayout':
          // 🔧 节级 setOrientation/setMargin 未确认，通过 customCode

  → 11. 批注  ⚠️ 仅确认 round-trip 保留 + resolve/unresolve，非 CRUD
    // 已确认：Comment.resolve(), Comment.unresolve(), Comment.isResolved()
    //   CommentManager.getResolvedComments(), CommentManager.getUnresolvedComments()
    // 未确认：addComment, replyComment, deleteComment
    // 实现阶段：优先验证是否有创建/删除 API；若无则通过 customCode 操作 comments.xml

  → 12. 修订控制  ⚠️ load-time revisionHandling + 重新加载实现
    // docxmlater 的修订处理是 load-time 行为，无法在同一个 doc 实例上运行时切换。
    // 实现方式：
    //   1. doc.save(tempFile) — 先保存当前内容
    //   2. doc.dispose()
    //   3. doc = Document.load(tempFile, { revisionHandling: action === 'acceptAll' ? 'accept' : 'reject' })
    //   4. doc.save(targetPath)
    // 或者通过 customCode 直接操作 word/settings.xml 中的 <w:trackRevisions/> 元素

  → 13. 文档级页面布局  ⚠️ createSection 已确认，布局方法 🔧
    // ✅ doc.createSection() 已确认
    // 🔧 setOrientation/setMargin/paperSize/insertToc 未确认

  → 14. 自定义代码（customCode） 🔧
    // customCode 的安全模型和项目已有的 shell 工具一致 —
    // Agent 本身就能 spawn Node 脚本，customCode 只是省去了临时文件
    // 和重复 load/save 的开销。
    if customCode:
      try:
        // 使用 AsyncFunction 构造，注入 { doc, fs, path } 上下文
        const fn = new AsyncFunction('doc', 'fs', 'path', customCode);
        await fn(doc, fs, path);
        log: "customCode 执行成功"
      catch (err):
        返回该组的 error 信息，不阻塞其他操作组和最终保存

  → doc.save(targetPath)
  → doc.dispose()

返回摘要：列出每个操作组的执行结果（替换数、段落/表格变更数、图片数、链接数等）
```

---

## 3. 文件结构

```
src/tools/builtins/files/
├── docx/
│   ├── docx-read-definition.ts      # docx_read ToolDefinition
│   ├── docx-create-definition.ts    # docx_create ToolDefinition
│   ├── docx-edit-definition.ts      # docx_edit ToolDefinition
│   ├── docx-capabilities.ts         # 共享的 ToolCapabilityDescriptor
│   ├── docx-engine.ts               # docxmlater 封装：load/save/create + markdown 解析
│   └── docx-markdown.ts             # Markdown ↔ docxmlater 元素转换器
├── read-definition.ts               # (existing)
├── write-definition.ts              # (existing)
├── edit-definition.ts               # (existing)
└── ...
```

**为什么独立 `docx/` 子目录？**

docx 工具共享一个 `docx-engine.ts`（封装 docxmlater 的 Document 生命周期管理）和一个 `docx-markdown.ts`（Markdown 解析/渲染），放在子目录内聚性更好。

### 3.1 依赖关系

```
docx-read-definition.ts  ─┐
docx-create-definition.ts ─┼── docx-engine.ts ── docxmlater (npm)
docx-edit-definition.ts   ─┘       │
                                   └── docx-markdown.ts
```

---

## 4. 注册流程

### 4.1 工具注册

在 `src/tools/builtins/index.ts` 新增导出：

```typescript
// v4 DOCX tools
export { createDocxReadToolDefinition, docxReadCapability } from './files/docx/docx-read-definition.js';
export { createDocxCreateToolDefinition, docxCreateCapability } from './files/docx/docx-create-definition.js';
export { createDocxEditToolDefinition, docxEditCapability } from './files/docx/docx-edit-definition.js';
```

在 `src/app/composers/tool-services.ts` 的 `registerV4ToolDefinitions()` 中新增：

```typescript
toolPlatformRegistry.registerDefinition(createDocxReadToolDefinition());
toolPlatformRegistry.registerDefinition(createDocxCreateToolDefinition());
toolPlatformRegistry.registerDefinition(createDocxEditToolDefinition());
```

### 4.2 npm 依赖

```bash
pnpm add docxmlater
```

`docxmlater` 的唯一传递依赖是 `jszip`，不会引入原生模块，Termux 兼容。

---

## 5. 可选配套：docx-editor Skill

为方便用户自然语言触发，在 `skills/` 下创建 `docx-editor/`：

```
skills/docx-editor/
├── SKILL.md              # Agent 指令
```

**SKILL.md 核心内容：**

```markdown
---
name: docx-editor
description: 创建和编辑 Word (.docx) 文档，支持文本编辑和表格操作
triggers: word, docx, 文档编辑, 生成报告, 创建合同, 表格编辑
allowed-tools:
  - docx_read
  - docx_create
  - docx_edit
  - file_read
  - file_write
  - file_edit
---

## 能力

你可以读取、创建和编辑 Microsoft Word (.docx) 文档。

### 读取文档
使用 docx_read 读取 .docx 文件内容，表格会以 Markdown 格式呈现。

### 创建文档
使用 docx_create 从 Markdown 内容创建新文档。支持的语法：
- # ~ ###### 标题
- **加粗** *斜体*
- - / 1. 列表
- | 表格 |

### 编辑文档
使用 docx_edit 修改已有文档，支持 13 类操作（可组合使用）：
- replacements: 全文搜索替换（支持正则）
- paragraphs: 插入、删除、编辑段落
- tableOperations: 表格增删行列、编辑单元格、合并、排序、边框
- formatting: 标题级别、字体/大小/颜色、加粗/斜体/下划线、高亮、对齐、行距、首行缩进
- lists: 项目符号/编号列表、重新开始编号
- images: 插入图片（PNG/JPEG/GIF/SVG）、删除图片、文字环绕
- hyperlinks: 添加超链接、批量更新 URL、移除链接
- headersFooters: 页眉页脚文字、页码、首页不同、奇偶页不同
- footnotes: 添加脚注/尾注、清除全部
- sections: 插入分节符、按节设置页面方向/页边距
- comments: 添加/回复/删除批注
- trackChanges: 接受或拒绝所有修订
- pageSetup: 文档级页面布局 + TOC 目录插入

### 工作流程
1. 先用 docx_read 查看文档内容
2. 确定需要修改的内容
3. 调用 docx_edit 执行修改
4. 或调用 docx_create 基于模板生成新文档
```

---

## 6. Capability 描述符

```typescript
// src/tools/builtins/files/docx/docx-capabilities.ts

import type { ToolCapabilityDescriptor } from '../../../platform/tool-capabilities.js';

export const docxReadCapability: ToolCapabilityDescriptor = {
  category: 'file',
  readOnly: true,
  readsFiles: true,
  writesFiles: false,
  usesShell: false,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'read',
  approvalDefault: 'none',
};

export const docxCreateCapability: ToolCapabilityDescriptor = {
  category: 'file',
  readOnly: false,
  readsFiles: false,
  writesFiles: true,
  usesShell: false,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'write',
  approvalDefault: 'none',
};

export const docxEditCapability: ToolCapabilityDescriptor = {
  category: 'file',
  readOnly: false,
  readsFiles: true,
  writesFiles: true,
  usesShell: false,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'read_write',
  approvalDefault: 'none',
};
```

---

## 7. docx-engine.ts 设计

封装 docxmlater 的 Document 生命周期，提供简洁的 API：

```typescript
// 接口设计（具体实现见实现阶段）

// ── 生命周期 ──

/** 加载已有文档 */
function loadDocx(filePath: string): Promise<DocxDocument>;

/** 创建新文档 */
function createDocx(): DocxDocument;

/** 保存文档 */
function saveDocx(doc: DocxDocument, filePath: string): Promise<number>;

/** 释放文档资源（所有操作完成后必须调用） */
function disposeDocx(doc: DocxDocument): void;

// ── 读取 ──

/** 读取文档为结构化 Markdown */
function toMarkdown(doc: DocxDocument, options?: { includeTables?: boolean; maxLength?: number }): string;

/** 获取文档元信息 */
function getInfo(doc: DocxDocument): { paragraphs: number; tables: Array<{ index: number; rows: number; cols: number }>; title?: string };

// ── 创建 ──

/** 从 Markdown 构建文档内容 */
function fromMarkdown(doc: DocxDocument, markdown: string): void;

// ── 编辑（对应 docx_edit 的 13 个操作组） ──

/** 文本搜索替换 */
function replaceText(doc: DocxDocument, replacements: Array<{ search: string; replace: string; flags?: string }>): number;

/** 段落增删改 */
function operateParagraphs(doc: DocxDocument, ops: ParagraphOp[]): void;

/** 表格操作 */
function operateTables(doc: DocxDocument, ops: TableOp[]): void;

/** 格式设置 */
function applyFormatting(doc: DocxDocument, formats: FormatOp[]): void;

/** 列表创建与编号控制 */
function manageLists(doc: DocxDocument, ops: ListOp[]): void;

/** 图片操作 */
function manageImages(doc: DocxDocument, ops: ImageOp[]): Promise<void>;

/** 超链接管理 */
function manageHyperlinks(doc: DocxDocument, ops: HyperlinkOp[]): void;

/** 页眉页脚 */
function setHeadersFooters(doc: DocxDocument, settings: HeadersFootersOp): void;

/** 脚注和尾注 */
function manageFootnotes(doc: DocxDocument, ops: FootnoteOp[]): void;

/** 分节管理 */
function manageSections(doc: DocxDocument, ops: SectionOp[]): void;

/** 批注管理 */
function manageComments(doc: DocxDocument, ops: CommentOp[]): void;

/** 修订控制 — 通过 Document.load({ revisionHandling }) 重新加载实现 */
function controlTrackChanges(doc: DocxDocument, action: 'acceptAll' | 'rejectAll'): Promise<DocxDocument>;

/** 页面布局 + TOC */
function setupPage(doc: DocxDocument, settings: PageSetupOp): void;
```

---

## 8. Markdown ↔ DOCX 转换

### 8.1 Markdown → DOCX（创建时）

| Markdown | docxmlater 调用 |
|----------|----------------|
| `# Title` | `doc.createParagraph().addText(...)`, 设置标题样式 |
| `**bold**` | `paragraph.addText('bold', { bold: true })` |
| `*italic*` | `paragraph.addText('italic', { italic: true })` |
| `- item` | 项目符号列表 |
| `1. item` | 编号列表 |
| `\| A \| B \|` | `doc.createTable(rows, cols)` → 逐单元格填充 |
| `---` | 分隔线 |
| 普通段落 | `doc.createParagraph().addText(text)` |

### 8.2 DOCX → Markdown（读取时）

| docxmlater 元素 | Markdown 输出 |
|----------------|--------------|
| Paragraph (bold) | `**text**` |
| Paragraph (italic) | `*text*` |
| Table | `\| cell \| cell \|` 带标题行分隔符 |
| 标题样式 | `# ~ ######` 前缀 |

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| docxmlater 社区小，可能停维 | 工具不可用 | MIT 许可，代码量可控；`jszip` 解压 + XML 操作可作为降级方案 |
| docxmlater API 文档不完善 | 开发时需看源码 | 先写集成测试覆盖核心路径，确认 API 行为 |
| 复杂表格（嵌套表格、合并单元格）读取不完整 | LLM 理解偏差 | `docx_read` 标注"合并单元格"提示，返回原始行列信息 |
| Markdown 解析边界 case | 创建文档格式错误 | 使用成熟的 Markdown 解析库（如 `marked`）辅助，仅转换支持的子集 |
| docxmlater 的内存管理（需手动 dispose） | 内存泄漏 | `docx-engine.ts` 统一管理生命周期，用 try-finally 确保 dispose |

---

## 10. 实施计划

### Phase 1：基础能力

- [ ] 安装 `docxmlater`，验证 Termux 兼容性
- [ ] 实现 `docx-engine.ts`（load / create / save / dispose）
- [ ] 实现 `docx-markdown.ts`（Markdown → docxmlater 元素，含表格）
- [ ] 实现 `docx_read` 工具
- [ ] 实现 `docx_create` 工具
- [ ] 编写集成测试：创建 → 读取 → 验证内容一致

### Phase 2：编辑能力

- [ ] 文本搜索替换（`replacements`）
- [ ] 段落增删改（`paragraphs`）
- [ ] 表格操作（`tableOperations`：8 种操作）
- [ ] 格式设置（`formatting`：标题、字体、高亮、对齐、行距、缩进）
- [ ] 列表操作（`lists`：项目符号、编号、重新开始编号）
- [ ] 图片操作（`images`：插入、删除、文字环绕）
- [ ] 超链接管理（`hyperlinks`：添加、更新 URL、移除）
- [ ] 页眉页脚（`headersFooters`：文字、页码、首页/奇偶页不同）
- [ ] 脚注尾注（`footnotes`：添加脚注、尾注、清除）
- [ ] 分节管理（`sections`：插入分节符、按节设置页面布局）
- [ ] 批注管理（`comments`）
- [ ] 修订控制（`trackChanges`）
- [ ] 文档级页面布局 + TOC（`pageSetup`）
- [ ] 组装 `docx_edit` 工具，13 组操作按序执行并返回各组执行摘要
- [ ] 编写集成测试：多组操作组合编辑，验证结果

### Phase 3：完善与集成

- [ ] 在 `tool-services.ts` 中注册 3 个工具
- [ ] 工具接入 PolicyCenter 权限检查
- [ ] 创建 `docx-editor` Skill
- [ ] 端到端测试：用户消息 → Skill 激活 → Agent 调用 docx 工具 → 返回结果

### Phase 4：增强（可选）

- [ ] 支持 `.docx` 模板填充（`fillTemplate(data)` — docxmlater 已内置）
- [ ] 实现 `docx_read` 的 `includeTables=false` 纯文本模式
- [ ] 文档样式预设库（报告模板、合同模板等）
- [ ] `customCode` 执行沙箱安全加固

---

## 11. 附录 A：docxmlater API 验证矩阵

每个操作组对应的底层 docxmlater API 及其确认状态。标记说明：

- ✅ **已确认** — npm 官方文档或 Socket.dev 分析中有明确 API 签名和示例
- ⚠️ **部分确认** — 功能在 feature list 中提及但具体方法名/签名未公开，或只有读取无写入
- 🔧 **需 customCode** — 无可用的公开 JavaScript API，需通过直接 XML 操作实现

### 1. replacements ✅
| API | 状态 | 备注 |
|-----|------|------|
| `doc.replaceText(pattern, replacement)` | ✅ | pattern 为 RegExp |
| `doc.findText(pattern)` | ✅ | |
| `doc.findParagraphsByText(pattern)` | ✅ | |

### 2. paragraphs ⚠️
| API | 状态 | 备注 |
|-----|------|------|
| `doc.createParagraph()` | ✅ | |
| `doc.removeElement(el)` | ✅ | 通用元素删除 |
| `doc.insertBefore(ref, el)` | ✅ | |
| `doc.replaceElement(old, new)` | ✅ | |
| `paragraph.addText(text, formatting)` | ✅ | |
| `doc.getParagraph(index)` | ❌ | **不存在** — 用 `getBodyElements()[index]` 替代 |
| `paragraph.removeAllChildren()` | ❌ | **不存在** — 用 `replaceElement` 或清空重建 |
| `doc.insertParagraphAt(index)` | ❌ | **不存在** — 用 `insertBefore(bodyElements[index], newPara)` |

### 3. tableOperations ⚠️
| API | 状态 | 备注 |
|-----|------|------|
| `doc.createTable(rows, cols)` | ✅ | |
| `table.getRow(index)` | ✅ | |
| `row.getCell(index)` | ✅ | |
| `table.addRow()` | ✅ | |
| `cell.createParagraph()` | ✅ | |
| `cell.setHorizontalMerge()` | ✅ | |
| `cell.setVerticalMerge()` | ✅ | |
| `table.sortRows()` | ✅ | |
| `table.setBorders(config)` | ✅ | |
| `doc.getTable(index)` | ❌ | **不存在** — 用 `getBodyElements().filter(e => e.type === 'table')` |
| `cell.removeAllChildren()` | ❌ | **不存在** — 用 `replaceElement` 替代 |
| `row.addCell()` | ❌ | **未确认** — addColumn 用遍历+cell追加实现 |
| `table.deleteColumn()` | ❌ | **未确认** — 用逐行 removeElement 实现 |

### 4. formatting ⚠️
| API | 状态 | 备注 |
|-----|------|------|
| `doc.findAndFormat(text, formatting)` | ✅ | 文本级格式 |
| `doc.findAndHighlight(text, color)` | ✅ | |
| `doc.setAllRunsFont(name)` | ✅ | 全文字体 |
| `doc.setAllRunsSize(size)` | ✅ | 全文字号 |
| `doc.setAllRunsColor(color)` | ✅ | 全文颜色 |
| `doc.addHeading(text, level)` | ✅ | 创建新标题 |
| `doc.getParagraphsByStyle(styleId)` | ✅ | 读取样式 |
| `para.setAlignment()` | ❌ | **不存在** — 🔧 customCode |
| `para.setLineSpacing()` | ❌ | **不存在** — 🔧 customCode |
| `para.setFirstLineIndent()` | ❌ | **不存在** — 🔧 customCode |
| 给已有段落设置标题样式 | ❌ | **不存在** — 🔧 customCode |

### 5. lists ✅
| API | 状态 | 备注 |
|-----|------|------|
| `doc.addBulletListFromArray(items)` | ✅ | |
| `doc.addNumberedListFromArray(items)` | ✅ | |
| `doc.restartNumbering(numId, level?, startValue?)` | ✅ | |

### 6. images ⚠️
| API | 状态 | 备注 |
|-----|------|------|
| `paragraph.addImage(buffer, { width, height, format })` | ✅ | PNG/JPEG/GIF/SVG/BMP |
| `doc.findImagesWithoutAltText()` | ✅ | 读取，非编辑 |
| `doc.optimizeImages()` | ✅ | 压缩优化 |
| `removeImage()` | ❌ | **不存在** — 🔧 customCode |
| `textWrapping` | ❌ | **不存在** — addImage 参数中未提及 |

### 7. hyperlinks ⚠️
| API | 状态 | 备注 |
|-----|------|------|
| `doc.getHyperlinks()` | ✅ | |
| `doc.updateHyperlinkUrls(oldUrl, newUrl)` | ✅ | 批量更新 |
| `paragraph.addHyperlink(link)` | ⚠️ | 文档中说"可以添加"但未给出具体签名 |
| `removeHyperlink()` | ❌ | **不存在** — 🔧 customCode |

### 8. headersFooters 🔧
| API | 状态 | 备注 |
|-----|------|------|
| 功能列表声明 | ✅ | "Headers & footers with first-page and odd/even variants" |
| `doc.createSection()` | ✅ | 节存在 |
| `section.getHeader()` | ❌ | **方法名未暴露** |
| `section.getFooter()` | ❌ | **方法名未暴露** |
| `addPageNumber()` | ❌ | **方法名未暴露**（页码作为 Field 类型提及） |
| **整体评估** | 🔧 | 全部需要 customCode 或实现阶段查看 TS 类型定义 |

### 9. footnotes ✅
| API | 状态 | 备注 |
|-----|------|------|
| `doc.createFootnote(paragraph, text)` | ✅ | |
| `doc.createEndnote(paragraph, text)` | ✅ | |
| `doc.clearFootnotes()` | ✅ | |
| `doc.clearEndnotes()` | ✅ | |
| `doc.getFootnoteManager()` | ✅ | |
| `doc.getEndnoteManager()` | ✅ | |

### 10. sections ⚠️
| API | 状态 | 备注 |
|-----|------|------|
| `doc.createSection()` | ✅ | |
| `section.setLineNumbering(opts)` | ✅ | |
| `section.getLineNumbering()` | ✅ | |
| `section.clearLineNumbering()` | ✅ | |
| `section.setOrientation()` | ❌ | **不存在** — 🔧 customCode |
| `section.setMargin()` | ❌ | **不存在** — 🔧 customCode |
| `doc.insertSectionBreak()` | ❌ | **方法名未确认** |

### 11. comments ⚠️
| API | 状态 | 备注 |
|-----|------|------|
| `Comment.resolve()` | ✅ | |
| `Comment.unresolve()` | ✅ | |
| `Comment.isResolved()` | ✅ | |
| `CommentManager.getResolvedComments()` | ✅ | 读取 |
| `CommentManager.getUnresolvedComments()` | ✅ | 读取 |
| `doc.addComment()` | ❌ | **未确认** |
| `doc.deleteComment()` | ❌ | **未确认** |
| `comment.reply()` | ❌ | **未确认** |

### 12. trackChanges ⚠️
| API | 状态 | 备注 |
|-----|------|------|
| `Document.load(path, { revisionHandling })` | ✅ | `'accept'` / `'reject'` / `'strip'` / `'preserve'` |
| `doc.enableTrackChanges()` | ✅ | 开启修订记录 |
| `doc.acceptAllChanges()` | ❌ | **不存在** — 运行时无法切换 |
| `doc.rejectAllChanges()` | ❌ | **不存在** — 运行时无法切换 |
| **注意** | | revisionHandling 是 **load-time** 参数，不是 runtime 方法 |

### 13. pageSetup ⚠️
| API | 状态 | 备注 |
|-----|------|------|
| `doc.createSection()` | ✅ | |
| `section.setOrientation()` | ❌ | **不存在** — 🔧 customCode |
| `section.setMargin()` | ❌ | **不存在** — 🔧 customCode |
| `section.setPaperSize()` | ❌ | **不存在** — 🔧 customCode |
| `insertToc()` | ❌ | **不存在** — TOC 作为 Field 类型提及，但无插入 API |

### 统计

| 状态 | 操作组数 |
|------|---------|
| ✅ 完全确认 | 3（replacements, lists, footnotes） |
| ⚠️ 部分确认 | 8（paragraphs, tableOperations, formatting, images, hyperlinks, sections, comments, pageSetup） |
| 🔧 需 customCode | 1（headersFooters） |
| ⚠️ 机制不同 | 1（trackChanges — load-time 而非 runtime） |

### customCode 覆盖的能力

以下操作组中的 🔧 标记项均可通过 `customCode` 参数实现（直接访问 doc 对象 + 操作底层 XML）：

- 段落级格式设置（对齐、行距、缩进）
- 图片删除
- 超链接删除
- 页眉页脚完整操作
- 分节布局（页面方向、边距）
- 批注创建和删除
- 运行时修订清理
- TOC 字段插入

---

## 12. 参考资料

- docxmlater npm: https://www.npmjs.com/package/docxmlater
- docxmlater playground: https://stackblitz.com/github/ItMeDiaTech/docXMLater/tree/main/playground
- 项目 v4 ToolDefinition 参考: `src/tools/builtins/files/edit-definition.ts`
- 项目工具注册参考: `src/app/composers/tool-services.ts`
