import { describe, it, expect } from 'vitest';
import {
  lintToolDescriptions,
  splitSentences,
  startsWithVerb,
  descriptionSimilarity,
} from '../../src/tools/tool-linter.js';

describe('tool-linter helpers', () => {
  it('splits sentences on EN and ZH terminators', () => {
    expect(splitSentences('Read a file. Returns content.')).toHaveLength(2);
    expect(splitSentences('读取文件。返回内容！')).toHaveLength(2);
    expect(splitSentences('One sentence only')).toHaveLength(1);
  });

  it('detects verb-start for EN inflections and ZH verbs', () => {
    expect(startsWithVerb('Read a file')).toBe(true);
    expect(startsWithVerb('Writes content to a file')).toBe(true);
    expect(startsWithVerb('获取当前时间')).toBe(true);
    expect(startsWithVerb('This tool reads files')).toBe(false);
    expect(startsWithVerb('')).toBe(false);
  });

  it('computes Jaccard similarity with CJK tokenization', () => {
    expect(descriptionSimilarity('read a file from disk', 'read a file from disk')).toBe(1);
    expect(descriptionSimilarity('read a file', 'send an email')).toBeLessThan(0.3);
    // Shared CJK chars give partial overlap
    const sim = descriptionSimilarity('读取文件内容', '读取文件路径');
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });
});

describe('lintToolDescriptions', () => {
  it('flags missing description as an error', () => {
    const report = lintToolDescriptions([
      { name: 'good_tool', description: 'Read a file from disk.' },
      { name: 'bad_tool', description: '' },
    ]);
    expect(report.ok).toBe(false);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]!.tool).toBe('bad_tool');
  });

  it('warns on long descriptions, non-verb start, and duplicates', () => {
    const report = lintToolDescriptions([
      { name: 'verbose_tool', description: 'One. Two. Three. Four.' },
      { name: 'nouny_tool', description: 'The file reader tool for files.' },
      { name: 'dupe_a', description: 'Read a file from the disk.' },
      { name: 'dupe_b', description: 'Read a file from the disk.' },
    ]);
    expect(report.ok).toBe(true); // warnings only
    const rules = report.warnings.map((w) => w.rule);
    expect(rules).toContain('description-concise');
    expect(rules).toContain('verb-start');
    expect(rules).toContain('description-similar');
  });

  it('passes well-formed orthogonal descriptions', () => {
    const report = lintToolDescriptions([
      { name: 'a', description: 'Read a file from disk.' },
      { name: 'b', description: 'Send a message to the user.' },
      { name: 'c', description: '获取当前系统时间。' },
    ]);
    expect(report.ok).toBe(true);
    expect(report.warnings).toHaveLength(0);
  });
});

// ── P6 inventory gate: real builtin definitions must lint clean ────────────

describe('builtin tool description orthogonality (inventory)', () => {
  it('every lintable builtin definition has a non-empty description', async () => {
    const { createShellToolDefinition } = await import('../../src/tools/builtins/shell/definition.js');
    const { createFileWriteToolDefinition } = await import('../../src/tools/builtins/files/write-definition.js');
    const { createFileEditToolDefinition } = await import('../../src/tools/builtins/files/edit-definition.js');
    const { createGlobToolDefinition } = await import('../../src/tools/builtins/files/glob-definition.js');
    const { createGrepToolDefinition } = await import('../../src/tools/builtins/files/grep-definition.js');
    const { createToolSearchToolDefinition } = await import('../../src/tools/builtins/session/tool-search-definition.js');
    const { createAskUserQuestionToolDefinition } = await import('../../src/tools/builtins/session/ask-definition.js');
    const { createBriefToolDefinition } = await import('../../src/tools/builtins/session/brief-definition.js');

    const report = lintToolDescriptions(
      [
        createShellToolDefinition(),
        createFileWriteToolDefinition(),
        createFileEditToolDefinition(),
        createGlobToolDefinition(),
        createGrepToolDefinition(),
        createToolSearchToolDefinition(),
        createAskUserQuestionToolDefinition(),
        createBriefToolDefinition(),
      ].map((d) => ({ name: d.name, description: d.description ?? '' })),
    );

    // Errors are hard failures; warnings are advisory (reported for triage).
    expect(
      report.errors,
      report.errors.map((e) => e.message).join('\n'),
    ).toEqual([]);
  });
});
