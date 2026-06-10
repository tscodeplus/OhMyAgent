import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentParser } from '../../src/multimodal/parsers/document.js';

function withTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'docparser-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('DocumentParser', () => {
  const parser = new DocumentParser();

  describe('extract', () => {
    it('should extract text from .txt files', async () => {
      const dir = withTempDir();
      const filePath = join(dir, 'test.txt');
      writeFileSync(filePath, 'Hello, world!\nThis is a test.', 'utf-8');

      const result = await parser.extract(filePath, 'text/plain');

      expect(result.kind).toBe('document');
      expect(result.text).toContain('Hello, world!');
      expect(result.text).toContain('This is a test.');
      expect(result.metadata?.size).toBeGreaterThan(0);
      expect(result.metadata?.mimeType).toBe('text/plain');
    });

    it('should extract text from .md files', async () => {
      const dir = withTempDir();
      const filePath = join(dir, 'readme.md');
      writeFileSync(filePath, '# Title\n\nSome *markdown* content.', 'utf-8');

      const result = await parser.extract(filePath, 'text/markdown');

      expect(result.kind).toBe('document');
      expect(result.text).toContain('# Title');
      expect(result.text).toContain('markdown');
    });

    it('should extract text from .json files', async () => {
      const dir = withTempDir();
      const filePath = join(dir, 'data.json');
      writeFileSync(filePath, JSON.stringify({ key: 'value', arr: [1, 2, 3] }), 'utf-8');

      const result = await parser.extract(filePath, 'application/json');

      expect(result.kind).toBe('document');
      expect(result.text).toContain('"key"');
      expect(result.text).toContain('"value"');
    });

    it('should extract text from .csv files', async () => {
      const dir = withTempDir();
      const filePath = join(dir, 'data.csv');
      writeFileSync(filePath, 'name,age\nAlice,30\nBob,25\n', 'utf-8');

      const result = await parser.extract(filePath, 'text/csv');

      expect(result.kind).toBe('document');
      expect(result.text).toContain('Alice');
      expect(result.text).toContain('Bob');
    });

    it('should truncate text > 50,000 chars', async () => {
      const dir = withTempDir();
      const filePath = join(dir, 'large.txt');
      writeFileSync(filePath, 'x'.repeat(60_000), 'utf-8');

      const result = await parser.extract(filePath, 'text/plain');

      expect(result.text).toContain('content truncated');
      expect(result.text!.length).toBeLessThan(51_000);
    });

    it('should return fallback description for .pdf files', async () => {
      const dir = withTempDir();
      const filePath = join(dir, 'doc.pdf');
      writeFileSync(filePath, '%PDF-1.4 fake pdf content');

      const result = await parser.extract(filePath, 'application/pdf');

      expect(result.kind).toBe('document');
      expect(result.text).toContain('[Document');
      expect(result.text).toContain('doc.pdf');
    });

    it('should return office description for .docx files', async () => {
      const dir = withTempDir();
      const filePath = join(dir, 'report.docx');
      writeFileSync(filePath, 'fake docx content');

      const result = await parser.extract(filePath, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

      expect(result.kind).toBe('document');
      expect(result.text).toContain('[Office document');
      expect(result.text).toContain('report.docx');
      expect(result.text).toContain('bytes');
    });

    it('should return office description for .xlsx files', async () => {
      const dir = withTempDir();
      const filePath = join(dir, 'sheet.xlsx');
      writeFileSync(filePath, 'fake xlsx content');

      const result = await parser.extract(filePath, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

      expect(result.kind).toBe('document');
      expect(result.text).toContain('[Office document');
      expect(result.text).toContain('sheet.xlsx');
    });

    it('should return fallback for unknown file types', async () => {
      const dir = withTempDir();
      const filePath = join(dir, 'archive.rar');
      writeFileSync(filePath, 'RAR archive data');

      const result = await parser.extract(filePath, 'application/vnd.rar');

      expect(result.kind).toBe('document');
      expect(result.text).toContain('[Document');
      expect(result.text).toContain('archive.rar');
    });

    it('should handle non-UTF8 text files gracefully', async () => {
      const dir = withTempDir();
      const filePath = join(dir, 'binary.bin');
      // .bin is not in the text-ext list, so it returns fallback
      writeFileSync(filePath, Buffer.from([0x00, 0x01, 0x02, 0x03]));

      const result = await parser.extract(filePath, 'application/octet-stream');

      expect(result.kind).toBe('document');
      expect(result.text).toContain('[Document');
    });

    it('should handle .yaml files', async () => {
      const dir = withTempDir();
      const filePath = join(dir, 'config.yaml');
      writeFileSync(filePath, 'key: value\nnested:\n  sub: val\n', 'utf-8');

      const result = await parser.extract(filePath, 'application/x-yaml');

      expect(result.kind).toBe('document');
      expect(result.text).toContain('key: value');
    });
  });
});
