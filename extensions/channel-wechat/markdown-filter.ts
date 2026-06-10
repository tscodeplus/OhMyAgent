/**
 * StreamingMarkdownFilter — 字符级状态机，有选择地过滤 Markdown 语法。
 * 微信不支持 HTML/Markdown 渲染，所以过滤掉"不渲染就很难看"的标记
 *（#标题、>引用、图片语法、CJK斜体），保留人眼可读的标记
 *（**粗体**、`代码`、表格、代码块、编号列表）。
 *
 * 通过标记的构造：
 *   - 代码块 (```) — 原样通过
 *   - 行内代码 (`) — 原样通过
 *   - 表格 (|...|) — 原样通过
 *   - 水平线 (---, ***, ___) — 原样通过
 *   - 粗体 (**) — 非 CJK 内容保留标记，CJK 内容去除标记
 *   - 斜体 (*), 粗斜体 (***) — 同上
 *
 * 过滤的构造：
 *   - 斜体/粗斜体包裹 CJK 内容 — 去标记，留内容
 *   - H5/H6 标题 (##### ######) — 去 #，留内容
 *   - 图片 (![alt](url)) — 整段移除
 *   - 删除线 (~~) — 去标记
 *   - 引用 (> ) — 去标记
 *   - 缩进 — 去除
 *
 * 流式友好：feed() 只输出可以确定的部分，
 * flush() 在消息结束时输出剩余缓冲。
 */

export class StreamingMarkdownFilter {
  private buf = '';
  private fence = false;
  private sol = true;
  private inl: { type: string; acc: string } | null = null;

  /** 输入 delta 文本，返回过滤后的文本 */
  feed(delta: string): string {
    this.buf += delta;
    return this.pump(false);
  }

  /** 流结束，输出剩余缓冲 */
  flush(): string {
    return this.pump(true);
  }

  private pump(eof: boolean): string {
    let out = '';
    while (this.buf) {
      const sLen = this.buf.length;
      const sSol = this.sol;
      const sFence = this.fence;
      const sInl = this.inl;

      if (this.fence) out += this.pumpFence(eof);
      else if (this.inl) out += this.pumpInline(eof);
      else if (this.sol) out += this.pumpSOL(eof);
      else out += this.pumpBody(eof);

      // 没有进展就退出（缓冲区不足，等待更多输入）
      if (this.buf.length === sLen && this.sol === sSol &&
          this.fence === sFence && this.inl === sInl) break;
    }

    if (eof && this.inl) {
      const markers: Record<string, string> = {
        image: '![', bold3: '***', italic: '*', ubold3: '___', uitalic: '_',
      };
      out += (markers[this.inl.type] ?? '') + this.inl.acc;
      this.inl = null;
    }
    return out;
  }

  // ── 代码块内：原样通过 ──
  private pumpFence(eof: boolean): string {
    if (this.sol) {
      if (this.buf.length < 3 && !eof) return '';
      if (this.buf.startsWith('```')) {
        const nl = this.buf.indexOf('\n', 3);
        if (nl !== -1) {
          this.fence = false;
          const line = this.buf.slice(0, nl + 1);
          this.buf = this.buf.slice(nl + 1);
          this.sol = true;
          return line;
        }
        if (eof) { this.fence = false; const r = this.buf; this.buf = ''; return r; }
        return '';
      }
      this.sol = false;
    }
    const nl = this.buf.indexOf('\n');
    if (nl !== -1) {
      const chunk = this.buf.slice(0, nl + 1);
      this.buf = this.buf.slice(nl + 1);
      this.sol = true;
      return chunk;
    }
    const chunk = this.buf; this.buf = ''; return chunk;
  }

  // ── 行首：检测并消费行首模式 ──
  private pumpSOL(eof: boolean): string {
    const b = this.buf;
    if (b[0] === '\n') { this.buf = b.slice(1); return '\n'; }

    // 代码块开启 ```
    if (b[0] === '`') {
      if (b.length < 3 && !eof) return '';
      if (b.startsWith('```')) {
        const nl = b.indexOf('\n', 3);
        if (nl !== -1) { this.fence = true; const line = b.slice(0, nl + 1); this.buf = b.slice(nl + 1); this.sol = true; return line; }
        if (eof) { this.buf = ''; return b; }
        return '';
      }
      this.sol = false; return '';
    }

    // 引用 > — 去标记
    if (b[0] === '>') { this.sol = false; return ''; }

    // H5/H6 标题 ##### ###### — 去 #
    if (b[0] === '#') {
      let n = 0;
      while (n < b.length && b[n] === '#') n++;
      if (n === b.length && !eof) return '';
      if (n >= 5 && n <= 6 && n < b.length && b[n] === ' ') {
        this.buf = b.slice(n + 1); this.sol = false; return '';
      }
      this.sol = false; return '';
    }

    // 缩进 — 去空格
    if (b[0] === ' ' || b[0] === '\t') {
      if (b.search(/[^ \t]/) === -1 && !eof) return '';
      this.sol = false; return '';
    }

    // 水平线 --- *** ___ — 原样通过
    if (b[0] === '-' || b[0] === '*' || b[0] === '_') {
      const ch = b[0]; let j = 0;
      while (j < b.length && (b[j] === ch || b[j] === ' ')) j++;
      if (j === b.length && !eof) return '';
      if (j === b.length || b[j] === '\n') {
        let count = 0;
        for (let k = 0; k < j; k++) if (b[k] === ch) count++;
        if (count >= 3) {
          const rest = j < b.length ? b.slice(j + 1) : '';
          const line = b.slice(0, j + 1);
          this.buf = rest; this.sol = rest ? true : this.sol;
          return line;
        }
      }
      this.sol = false; return '';
    }

    this.sol = false; return '';
  }

  // ── 行内扫描：检测内联标记触发 ──
  private pumpBody(eof: boolean): string {
    let out = '';
    let i = 0;
    while (i < this.buf.length) {
      const c = this.buf[i];
      if (c === '\n') {
        out += this.buf.slice(0, i + 1);
        this.buf = this.buf.slice(i + 1);
        this.sol = true;
        return out;
      }
      // 图片 ![ — 整段移除
      if (c === '!' && i + 1 < this.buf.length && this.buf[i + 1] === '[') {
        out += this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 2);
        this.inl = { type: 'image', acc: '' };
        return out;
      }
      // 删除线 ~~ — 去标记
      if (c === '~') { i++; continue; }
      // 粗斜体 *** 或 粗体 ** 或 斜体 *
      if (c === '*') {
        if (i + 2 < this.buf.length && this.buf[i + 1] === '*' && this.buf[i + 2] === '*') {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 3);
          this.inl = { type: 'bold3', acc: '' };
          return out;
        }
        if (i + 1 < this.buf.length && this.buf[i + 1] === '*') { i += 2; continue; }
        if (i + 1 < this.buf.length && this.buf[i + 1] !== ' ' && this.buf[i + 1] !== '\n') {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 1);
          this.inl = { type: 'italic', acc: '' };
          return out;
        }
        i++; continue;
      }
      // 下划线粗体 ___ 或 下划线斜体 _
      if (c === '_') {
        if (i + 2 < this.buf.length && this.buf[i + 1] === '_' && this.buf[i + 2] === '_') {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 3);
          this.inl = { type: 'ubold3', acc: '' };
          return out;
        }
        if (i + 1 < this.buf.length && this.buf[i + 1] === '_') { i += 2; continue; }
        if (i + 1 < this.buf.length && this.buf[i + 1] !== ' ' && this.buf[i + 1] !== '\n') {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 1);
          this.inl = { type: 'uitalic', acc: '' };
          return out;
        }
        i++; continue;
      }
      i++;
    }
    // 尾部保留：可能在等待闭合标记
    let hold = 0;
    if (!eof) {
      if (this.buf.endsWith('**')) hold = 2;
      else if (this.buf.endsWith('__')) hold = 2;
      else if (this.buf.endsWith('*')) hold = 1;
      else if (this.buf.endsWith('_')) hold = 1;
      else if (this.buf.endsWith('!')) hold = 1;
    }
    out += this.buf.slice(0, this.buf.length - hold);
    this.buf = hold > 0 ? this.buf.slice(-hold) : '';
    return out;
  }

  // ── 内联内容累积：直到闭合标记 ──
  private pumpInline(_eof: boolean): string {
    if (!this.inl) return '';
    this.inl.acc += this.buf;
    this.buf = '';

    switch (this.inl.type) {
      case 'bold3': { // ***bold-italic***
        const idx = this.inl.acc.indexOf('***');
        if (idx !== -1) {
          const content = this.inl.acc.slice(0, idx);
          this.buf = this.inl.acc.slice(idx + 3); this.inl = null;
          return StreamingMarkdownFilter.containsCJK(content) ? content : `***${content}***`;
        }
        return '';
      }
      case 'ubold3': { // ___bold-italic___
        const idx = this.inl.acc.indexOf('___');
        if (idx !== -1) {
          const content = this.inl.acc.slice(0, idx);
          this.buf = this.inl.acc.slice(idx + 3); this.inl = null;
          return StreamingMarkdownFilter.containsCJK(content) ? content : `___${content}___`;
        }
        return '';
      }
      case 'italic': { // *italic*
        for (let j = 0; j < this.inl.acc.length; j++) {
          if (this.inl.acc[j] === '\n') {
            const r = '*' + this.inl.acc.slice(0, j + 1);
            this.buf = this.inl.acc.slice(j + 1); this.inl = null; this.sol = true;
            return r;
          }
          if (this.inl.acc[j] === '*') {
            if (j + 1 < this.inl.acc.length && this.inl.acc[j + 1] === '*') { j++; continue; }
            const content = this.inl.acc.slice(0, j);
            this.buf = this.inl.acc.slice(j + 1); this.inl = null;
            return StreamingMarkdownFilter.containsCJK(content) ? content : `*${content}*`;
          }
        }
        return '';
      }
      case 'uitalic': { // _italic_
        for (let j = 0; j < this.inl.acc.length; j++) {
          if (this.inl.acc[j] === '\n') {
            const r = '_' + this.inl.acc.slice(0, j + 1);
            this.buf = this.inl.acc.slice(j + 1); this.inl = null; this.sol = true;
            return r;
          }
          if (this.inl.acc[j] === '_') {
            if (j + 1 < this.inl.acc.length && this.inl.acc[j + 1] === '_') { j++; continue; }
            const content = this.inl.acc.slice(0, j);
            this.buf = this.inl.acc.slice(j + 1); this.inl = null;
            return StreamingMarkdownFilter.containsCJK(content) ? content : `_${content}_`;
          }
        }
        return '';
      }
      case 'image': { // ![alt](url) — 整段移除
        const cb = this.inl.acc.indexOf(']');
        if (cb === -1) return '';
        if (cb + 1 >= this.inl.acc.length) return '';
        if (this.inl.acc[cb + 1] !== '(') {
          const r = '![' + this.inl.acc.slice(0, cb + 1);
          this.buf = this.inl.acc.slice(cb + 1); this.inl = null;
          return r;
        }
        const cp = this.inl.acc.indexOf(')', cb + 2);
        if (cp !== -1) {
          this.buf = this.inl.acc.slice(cp + 1); this.inl = null;
          return '';
        }
        return '';
      }
    }
    return '';
  }

  static containsCJK(text: string): boolean {
    return /[⺀-鿿가-힯豈-﫿]/.test(text);
  }
}
