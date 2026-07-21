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
// 需要注入到 Agent 代码中的 docxmlater 类型
let Document, Image, ImageRun, Table, TableRow, TableCell, Paragraph, Run;
try {
  ({ Document, Image, ImageRun, Table, TableRow, TableCell, Paragraph, Run } = await import('docxmlater'));
} catch {
  console.log('[docx-helper] docxmlater 未安装，正在自动安装...');
  execSync('pnpm add docxmlater', { stdio: 'inherit', cwd: process.cwd() });
  ({ Document, Image, ImageRun, Table, TableRow, TableCell, Paragraph, Run } = await import('docxmlater'));
  console.log('[docx-helper] docxmlater 安装完成');
}

// ═══════════════════════════════════════════════════════════════════
// 简易参数解析（避免引入额外依赖）
// ═══════════════════════════════════════════════════════════════════
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
// --run : 编辑模式。注入 doc, console, fs, path 到 Agent 代码的上
// 下文。
// ═══════════════════════════════════════════════════════════════════
if (args.run) {
  const doc = args.input
    ? await Document.load(args.input, { revisionHandling: 'preserve' })
    : Document.create();

  try {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const fn = new AsyncFunction('doc', 'console', 'fs', 'path', 'Image', 'ImageRun', args.code);
    await fn(doc, console, fs, path, Image, ImageRun);
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
// introspect() — API 自发现引擎
// ═══════════════════════════════════════════════════════════════════
function introspect(target) {
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
    if (!subjects[target]) {
      doc.dispose();
      return `ERROR: Unknown type "${target}". Available: ${Object.keys(subjects).join(', ')}`;
    }
    return formatAPI(target, subjects[target], doc);
  }

  // 无参数：列出所有可探查的类型
  doc.dispose();
  return Object.keys(subjects).map(k => `  ${k}`).join('\n');
}

function formatAPI(name, instance, doc) {
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

// ═══════════════════════════════════════════════════════════════════
// docToMarkdown — 将 Document 转为结构化 Markdown
// ═══════════════════════════════════════════════════════════════════
function docToMarkdown(doc) {
  const lines = [];
  for (const el of doc.getBodyElements()) {
    if (el.constructor.name === 'Table') {
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
      const runs = para.getRuns?.() ?? [];
      if (runs.length === 0) {
        lines.push(para.getText?.() ?? '');
      } else {
        const parts = runs.map(run => {
          let text = run.text ?? run.getText?.() ?? '';
          if (!text) return '';
          const fmt = run.formatting ?? {};
          if (fmt.bold) text = `**${text}**`;
          if (fmt.italic) text = `*${text}*`;
          return text;
        });
        lines.push(parts.join(''));
      }
    }
  }
  return lines.join('\n');
}
