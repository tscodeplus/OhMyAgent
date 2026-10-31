/**
 * The note body editor: a textarea with a markdown toolbar.
 *
 * Why not a package: the notes corpus is short atoms (a command, a pitfall, a
 * five-line workflow), written mostly from a phone browser. A full editor
 * (@uiw/react-md-editor, CodeMirror, EasyMDE) buys collaborative niceties this
 * panel does not use, ships its own CSS that fights the Tailwind class-based
 * dark theme, hardcodes English button labels past our i18n parity test, and
 * renders a second preview implementation that would drift from `NoteBody`.
 * A hundred lines of selection surgery over the textarea we already have keeps
 * one renderer, one stylesheet and one dictionary.
 *
 * Three mechanics that matter:
 *
 * - **Undo is ours, not the browser's.** Toolbar edits assign `value`, which
 *   breaks the native undo stack (only `execCommand('insertText')` keeps it, and
 *   it cannot express a wrap or a line toggle). So the component keeps its own
 *   history: typing is coalesced by 350 ms of idle, toolbar actions commit at
 *   once, and Ctrl/Cmd+Z is intercepted so the keyboard and the buttons agree.
 *   Without that interception the browser would sometimes undo *part* of a
 *   toolbar edit and leave a half-wrapped line.
 * - **Wrapping is a toggle**: pressing 加粗 on already-bold text removes the
 *   markers instead of nesting a second pair.
 * - **The preview is `NoteBody`**, the renderer the reading view uses, so what
 *   you see while writing is what gets rendered after saving.
 *
 * The toolbar scrolls horizontally instead of wrapping: nine formatting buttons
 * plus two modes do not fit a 414px phone, and a second toolbar row would eat
 * the writing area, which is the point of the panel.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bold,
  Code,
  Heading2,
  Italic,
  Link2,
  List,
  ListOrdered,
  Quote,
  Redo2,
  SquareCode,
  Undo2,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { NoteBody } from './NoteBits';

interface MarkdownEditorProps {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  rows?: number;
}

/** Idle time after which a burst of typing becomes one undo step. */
const COALESCE_MS = 350;
/** Undo depth. A note body is never long enough to need more. */
const HISTORY_LIMIT = 120;

export default function MarkdownEditor({
  value,
  onChange,
  placeholder,
  ariaLabel,
  rows = 14,
}: MarkdownEditorProps) {
  const { t } = useTranslation('common');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');

  // ── history (see the header note on why this is hand-rolled) ─────────────
  const historyRef = useRef<string[]>([value]);
  const cursorRef = useRef(0);
  const latestRef = useRef(value);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const syncFlags = useCallback(() => {
    setCanUndo(cursorRef.current > 0);
    setCanRedo(cursorRef.current < historyRef.current.length - 1);
  }, []);

  /** Add `next` as a new undo step, dropping any redo branch it supersedes. */
  const commit = useCallback(
    (next: string) => {
      const trimmed = historyRef.current.slice(0, cursorRef.current + 1);
      if (trimmed[trimmed.length - 1] === next) {
        syncFlags();
        return;
      }
      trimmed.push(next);
      if (trimmed.length > HISTORY_LIMIT) trimmed.shift();
      historyRef.current = trimmed;
      cursorRef.current = trimmed.length - 1;
      syncFlags();
    },
    [syncFlags],
  );

  /** A pending typing burst becomes a step before any other history action. */
  const flushTyping = useCallback(() => {
    if (!idleTimerRef.current) return;
    clearTimeout(idleTimerRef.current);
    idleTimerRef.current = null;
    commit(latestRef.current);
  }, [commit]);

  const applyHistory = useCallback(
    (nextCursor: number) => {
      const text = historyRef.current[nextCursor];
      if (text === undefined) return;
      cursorRef.current = nextCursor;
      latestRef.current = text;
      onChange(text);
      syncFlags();
      // Restore focus without scroll-jumping the panel.
      textareaRef.current?.focus({ preventScroll: true });
    },
    [onChange, syncFlags],
  );

  const undo = useCallback(() => {
    flushTyping();
    if (cursorRef.current === 0) return;
    applyHistory(cursorRef.current - 1);
  }, [applyHistory, flushTyping]);

  const redo = useCallback(() => {
    flushTyping();
    if (cursorRef.current >= historyRef.current.length - 1) return;
    applyHistory(cursorRef.current + 1);
  }, [applyHistory, flushTyping]);

  useEffect(() => () => void (idleTimerRef.current && clearTimeout(idleTimerRef.current)), []);

  /** Write `next` into the textarea, select `[selStart, selEnd]`, record it. */
  const applyValue = useCallback(
    (next: string, selStart: number, selEnd: number) => {
      const el = textareaRef.current;
      // A pending typing burst must land *before* the toolbar edit, so undo
      // walks back through the typing and then the formatting.
      flushTyping();
      if (el) {
        el.value = next;
        el.focus();
        el.setSelectionRange(selStart, selEnd);
      }
      latestRef.current = next;
      onChange(next);
      commit(next);
    },
    [commit, flushTyping, onChange],
  );

  const handleTyping = useCallback(
    (next: string) => {
      latestRef.current = next;
      onChange(next);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        idleTimerRef.current = null;
        commit(latestRef.current);
      }, COALESCE_MS);
    },
    [commit, onChange],
  );

  // ── markdown editing operations ─────────────────────────────────────────
  const wrap = useCallback(
    (before: string, after: string) => {
      const el = textareaRef.current;
      if (!el) return;
      const { selectionStart: start, selectionEnd: end, value: text } = el;
      const selected = text.slice(start, end);

      // Toggle off when the markers are already there — a second click means
      // "undo", and `****text****` is never what anyone wanted.
      const hasBefore = text.slice(Math.max(0, start - before.length), start) === before;
      const hasAfter = text.slice(end, end + after.length) === after;
      if (hasBefore && hasAfter) {
        const caret = start - before.length;
        applyValue(
          text.slice(0, caret) + selected + text.slice(end + after.length),
          caret,
          caret + selected.length,
        );
        return;
      }

      const innerStart = start + before.length;
      applyValue(
        `${text.slice(0, start)}${before}${selected}${after}${text.slice(end)}`,
        innerStart,
        innerStart + selected.length,
      );
    },
    [applyValue],
  );

  const prefixLines = useCallback(
    (prefix: string) => {
      const el = textareaRef.current;
      if (!el) return;
      const { selectionStart: start, selectionEnd: end, value: text } = el;
      const lineStart = text.lastIndexOf('\n', start - 1) + 1;
      const nextBreak = text.indexOf('\n', end);
      const lineEnd = nextBreak === -1 ? text.length : nextBreak;
      const lines = text.slice(lineStart, lineEnd).split('\n');
      const allPrefixed = lines.every((line) => line.startsWith(prefix));
      const rewritten = lines
        .map((line) => {
          if (allPrefixed) return line.slice(prefix.length);
          return line.startsWith(prefix) ? line : `${prefix}${line}`;
        })
        .join('\n');
      applyValue(
        text.slice(0, lineStart) + rewritten + text.slice(lineEnd),
        lineStart,
        lineStart + rewritten.length,
      );
    },
    [applyValue],
  );

  const fence = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const { selectionStart: start, selectionEnd: end, value: text } = el;
    const selected = text.slice(start, end);
    const block = selected ? `\`\`\`\n${selected}\n\`\`\`\n` : '```\n\n```\n';
    const caret = selected ? start + block.length : start + 4;
    applyValue(text.slice(0, start) + block + text.slice(end), caret, caret);
  }, [applyValue]);

  const insertLink = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const { selectionStart: start, selectionEnd: end, value: text } = el;
    const selected = text.slice(start, end);
    if (selected) {
      const snippet = `[${selected}](https://)`;
      const caret = start + snippet.length - 1;
      applyValue(text.slice(0, start) + snippet + text.slice(end), caret, caret);
    } else {
      const snippet = `[${t('notes.editor.linkText')}](https://)`;
      const from = start + 1;
      applyValue(
        text.slice(0, start) + snippet + text.slice(end),
        from,
        from + t('notes.editor.linkText').length,
      );
    }
  }, [applyValue, t]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if (key === 'y') {
      event.preventDefault();
      redo();
    } else if (key === 'b') {
      event.preventDefault();
      wrap('**', '**');
    } else if (key === 'i') {
      event.preventDefault();
      wrap('*', '*');
    } else if (key === 'k') {
      event.preventDefault();
      insertLink();
    }
  };

  const tools = [
    { icon: Bold, label: t('notes.editor.bold'), run: () => wrap('**', '**') },
    { icon: Italic, label: t('notes.editor.italic'), run: () => wrap('*', '*') },
    { icon: Code, label: t('notes.editor.inlineCode'), run: () => wrap('`', '`') },
    { icon: Heading2, label: t('notes.editor.heading'), run: () => prefixLines('## ') },
    { icon: List, label: t('notes.editor.bulletList'), run: () => prefixLines('- ') },
    { icon: ListOrdered, label: t('notes.editor.orderedList'), run: () => prefixLines('1. ') },
    { icon: Quote, label: t('notes.editor.quote'), run: () => prefixLines('> ') },
    { icon: SquareCode, label: t('notes.editor.codeBlock'), run: fence },
    { icon: Link2, label: t('notes.editor.link'), run: insertLink },
  ];

  return (
    <div className="overflow-hidden rounded-md border border-neutral-300 bg-white focus-within:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:focus-within:border-neutral-600">
      <div className="flex items-center gap-1 border-b border-neutral-200 bg-neutral-50/80 px-1 py-1 dark:border-neutral-800 dark:bg-neutral-900/80">
        {/* Undo/redo stay out of the scrolling strip: they are the two buttons a
            phone user reaches for, and they must never be the ones scrolled away. */}
        <div className="flex shrink-0 items-center gap-0.5 border-r border-neutral-200 pr-1 dark:border-neutral-800">
          <ToolButton
            icon={Undo2}
            label={t('notes.editor.undo')}
            onClick={undo}
            disabled={!canUndo}
          />
          <ToolButton
            icon={Redo2}
            label={t('notes.editor.redo')}
            onClick={redo}
            disabled={!canRedo}
          />
        </div>

        <div className="relative min-w-0 flex-1">
          <div className="flex items-center gap-0.5 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {tools.map(({ icon: Icon, label, run }) => (
              <ToolButton key={label} icon={Icon} label={label} onClick={run} />
            ))}
          </div>
          {/* The fade is the only hint that there are more buttons to the right;
              a strip clipped mid-icon reads as broken rather than scrollable. */}
          <div className="pointer-events-none absolute inset-y-0 right-0 w-5 bg-gradient-to-l from-neutral-50/95 to-transparent dark:from-neutral-900/95" />
        </div>

        <div className="flex shrink-0 items-center gap-0.5 border-l border-neutral-200 pl-1 dark:border-neutral-800">
          {(['edit', 'preview'] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setMode(item)}
              className={cn(
                'rounded px-1.5 py-0.5 text-[11px] transition-colors',
                mode === item
                  ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                  : 'text-neutral-500 hover:bg-neutral-200/70 dark:text-neutral-400 dark:hover:bg-neutral-800',
              )}
            >
              {t(item === 'edit' ? 'notes.editor.modeEdit' : 'notes.editor.modePreview')}
            </button>
          ))}
        </div>
      </div>

      {mode === 'edit' ? (
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => handleTyping(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={ariaLabel ?? placeholder}
          rows={rows}
          spellCheck={false}
          className="w-full resize-y border-0 bg-transparent px-2.5 py-2 font-mono text-[12.5px] leading-relaxed text-neutral-800 placeholder:text-neutral-400 focus:outline-none dark:text-neutral-200"
        />
      ) : (
        <div className="min-h-[8rem] px-3 py-2">
          {value.trim() ? (
            <NoteBody body={value} />
          ) : (
            <p className="text-[12px] text-neutral-400 dark:text-neutral-500">
              {t('notes.editor.emptyPreview')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ToolButton({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: typeof Bold;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      // Keep the textarea's selection: `onClick` alone clears it in some browsers.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-neutral-500 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900 disabled:opacity-30 disabled:hover:bg-transparent dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={2} />
    </button>
  );
}
