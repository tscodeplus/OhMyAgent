// ---------------------------------------------------------------------------
// v4 ToolDefinition for the lsp tool (regex-based fallback)
// ---------------------------------------------------------------------------

import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { Type } from 'typebox';
import type { Static } from 'typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import type { ToolExecutionContext } from '../../platform/tool-context.js';
import type { ToolExecutionResult } from '../../platform/tool-result.js';
import { textResult, errorResult } from '../../platform/tool-result.js';

export const lspCapability: ToolCapabilityDescriptor = {
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

const VALID_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

const paramsSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal('definition'),
      Type.Literal('references'),
      Type.Literal('hover'),
      Type.Literal('symbols'),
    ],
    { description: 'LSP action to perform' },
  ),
  filePath: Type.String({ description: 'Path to the file' }),
  line: Type.Number({ description: 'Line number (0-indexed)' }),
  column: Type.Number({ description: 'Column number (0-indexed)' }),
});

type LspArgs = Static<typeof paramsSchema>;

export function createLspToolDefinition(): ToolDefinition<LspArgs> {
  return {
    name: 'lsp',
    label: 'LSP (Regex-based)',
    description:
      'Regex-based LSP for TypeScript/JavaScript: goto-definition, hover-type, references.',
    category: 'file',
    parametersSchema: paramsSchema,
    capability: lspCapability,
    execute: async (args: LspArgs, ctx: ToolExecutionContext) => {
      const { action, filePath, line, column } = args;
      const resolvedPath = resolve(ctx.cwd, filePath);

      const extMatch = resolvedPath.match(/\.\w+$/);
      const ext = extMatch?.[0]?.toLowerCase();
      if (!ext || !VALID_EXTENSIONS.includes(ext)) {
        return errorResult(
          `LSP tool only supports TypeScript/JavaScript files (.ts, .tsx, .js, .jsx). Got: ${ext ?? 'unknown'}`,
        );
      }

      try {
        const content = await readFile(resolvedPath, 'utf-8');
        const lines = content.split('\n');

        switch (action) {
          case 'symbols':
            return handleSymbolsLines(lines);
          case 'definition':
            return handleDefinitionLines(lines, resolvedPath, line, column);
          case 'references':
            return handleReferencesLines(lines, line, column);
          case 'hover':
            return handleHoverLines(lines, line, column);
          default:
            return errorResult(`Unknown action: ${action}`);
        }
      } catch (error: any) {
        return errorResult(`LSP error: ${error.message}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the word (contiguous \\w characters) at a given (lineText, column). */
function extractWordAtPosition(lineText: string, column: number): string | null {
  if (column >= lineText.length) return null;
  let start = column;
  let end = column;
  while (start > 0 && /\w/.test(lineText[start - 1])) start--;
  while (end < lineText.length && /\w/.test(lineText[end])) end++;
  return start < end ? lineText.slice(start, end) : null;
}

// ---------------------------------------------------------------------------
// Action: symbols
// ---------------------------------------------------------------------------

interface SymbolInfo {
  name: string;
  kind: string;
  line: number;
}

function handleSymbolsLines(lines: string[]): ToolExecutionResult {
  const symbols: SymbolInfo[] = [];
  const seenKeys = new Set<string>();

  const patternEntries: [RegExp, string][] = [
    [/export\s+(?:const|let|var|function|class|interface|type|enum)\s+(\w+)/, 'export'],
    [/function\s+(\w+)/, 'function'],
    [/class\s+(\w+)/, 'class'],
    [/interface\s+(\w+)/, 'interface'],
    [/type\s+(\w+)/, 'type alias'],
    [/enum\s+(\w+)/, 'enum'],
    [/(?:const|let|var)\s+(\w+)/, 'variable'],
  ];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      continue;
    }

    for (const [regex, kind] of patternEntries) {
      const match = lines[i].match(regex);
      if (match) {
        const key = `${match[1]}:${i}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          symbols.push({ name: match[1], kind, line: i });
        }
        break; // Only one match per line (priority by pattern order)
      }
    }
  }

  if (symbols.length === 0) {
    return textResult('No symbols found in file.');
  }

  const formatted = symbols.map((s) => `  ${s.name} (${s.kind}, line ${s.line})`).join('\n');
  return textResult(`Symbols (${symbols.length}):\n${formatted}`);
}

// ---------------------------------------------------------------------------
// Action: definition
// ---------------------------------------------------------------------------

function handleDefinitionLines(
  lines: string[],
  filePath: string,
  line: number,
  column: number,
): ToolExecutionResult {
  if (line < 0 || line >= lines.length) {
    return errorResult(`Line ${line} out of range (file has ${lines.length} lines)`);
  }

  const targetLine = lines[line];
  const word = extractWordAtPosition(targetLine, column);
  if (!word) {
    return errorResult(`No word found at line ${line}, column ${column}`);
  }

  // Check if this is an import statement
  const importPattern =
    /import\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+(?:,\s*\S+)?)\s+from\s+['"]([^'"]+)['"]/;
  const importMatch = targetLine.match(importPattern);
  if (importMatch) {
    return textResult(
      `Symbol "${word}" is imported from "${importMatch[1]}".\n` +
        'Full definition resolution requires a full TypeScript compiler.',
    );
  }

  // Search file for definition patterns
  const defPatterns: [RegExp, string][] = [
    [/function\s+(\w+)/, 'function'],
    [/class\s+(\w+)/, 'class'],
    [/(?:const|let|var)\s+(\w+)/, 'variable'],
    [/interface\s+(\w+)/, 'interface'],
    [/type\s+(\w+)/, 'type alias'],
    [/enum\s+(\w+)/, 'enum'],
  ];

  for (let i = 0; i < lines.length; i++) {
    for (const [regex, kind] of defPatterns) {
      const match = lines[i].match(regex);
      if (match && match[1] === word) {
        const lineContent = lines[i].trim();
        return textResult(`Definition of "${word}" (${kind}) found at line ${i}:\n  ${lineContent}`);
      }
    }
  }

  return textResult(`No definition found for "${word}" in the current file.`);
}

// ---------------------------------------------------------------------------
// Action: references
// ---------------------------------------------------------------------------

function handleReferencesLines(
  lines: string[],
  line: number,
  column: number,
): ToolExecutionResult {
  if (line < 0 || line >= lines.length) {
    return errorResult(`Line ${line} out of range (file has ${lines.length} lines)`);
  }

  const word = extractWordAtPosition(lines[line], column);
  if (!word) {
    return errorResult(`No word found at line ${line}, column ${column}`);
  }

  const references: Array<{ line: number; column: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    let col = 0;
    while (col < lineText.length) {
      const idx = lineText.indexOf(word, col);
      if (idx === -1) break;
      const before = idx > 0 ? lineText[idx - 1] : ' ';
      const after = idx + word.length < lineText.length ? lineText[idx + word.length] : ' ';
      if (!/\w/.test(before) && !/\w/.test(after)) {
        references.push({ line: i, column: idx });
      }
      col = idx + 1;
    }
  }

  if (references.length === 0) {
    return textResult(`No references found for "${word}".`);
  }

  const refText = references
    .map((r) => `  Line ${r.line}, col ${r.column}: ${lines[r.line].trim()}`)
    .join('\n');
  return textResult(`Found ${references.length} reference(s) for "${word}":\n${refText}`);
}

// ---------------------------------------------------------------------------
// Action: hover
// ---------------------------------------------------------------------------

function handleHoverLines(lines: string[], line: number, column: number): ToolExecutionResult {
  if (line < 0 || line >= lines.length) {
    return errorResult(`Line ${line} out of range (file has ${lines.length} lines)`);
  }

  const word = extractWordAtPosition(lines[line], column);
  if (!word) {
    return errorResult(`No word found at line ${line}, column ${column}`);
  }

  const startLine = Math.max(0, line - 3);
  const endLine = Math.min(lines.length - 1, line + 3);

  const contextLines: string[] = [];
  for (let i = startLine; i <= endLine; i++) {
    const prefix = i === line ? '>' : ' ';
    contextLines.push(`${prefix} ${i}: ${lines[i]}`);
  }

  return textResult(
    `Symbol: "${word}"\n` +
    `Location: line ${line}, column ${column}\n` +
    'Context:\n' +
    contextLines.join('\n'),
  );
}
