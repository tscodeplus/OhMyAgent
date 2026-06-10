// ---------------------------------------------------------------------------
// v4 ToolDefinition for the notebook_edit tool
// ---------------------------------------------------------------------------

import { Type } from 'typebox';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { textResult, errorResult } from '../../platform/tool-result.js';

export const notebookEditCapability: ToolCapabilityDescriptor = {
  category: 'file',
  readOnly: false,
  readsFiles: true,
  writesFiles: true,
  usesShell: false,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'read_write',
  approvalDefault: 'mutating',
};

interface NotebookCell {
  cell_type: string;
  source: string | string[];
  metadata: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
}

interface Notebook {
  nbformat: number;
  nbformat_minor: number;
  metadata: Record<string, unknown>;
  cells: NotebookCell[];
}

/** Convert source to string array split by newlines (Jupyter convention). */
function sourceToLines(source: string): string[] {
  return source.split('\n');
}

/** Convert cell source (string or string[]) to a single string. */
function sourceToString(source: string | string[]): string {
  if (Array.isArray(source)) return source.join('');
  return source;
}

export function createNotebookEditToolDefinition(): ToolDefinition {
  return {
    name: 'notebook_edit',
    label: 'Notebook Edit',
    description:
      'Modify Jupyter notebook (.ipynb) cells: insert, replace, or delete.',
    category: 'file',
    parametersSchema: Type.Object({
      filePath: Type.String({
        description: 'Path to the .ipynb file',
      }),
      action: Type.Union(
        [
          Type.Literal('insert_cell'),
          Type.Literal('replace_cell'),
          Type.Literal('delete_cell'),
          Type.Literal('update_cell_source'),
        ],
        { description: 'Action to perform' },
      ),
      index: Type.Optional(
        Type.Number({ description: 'Cell index (0-based)' }),
      ),
      cellType: Type.Optional(
        Type.Union(
          [
            Type.Literal('code'),
            Type.Literal('markdown'),
            Type.Literal('raw'),
          ],
          { description: 'Cell type for insert/replace' },
        ),
      ),
      source: Type.Optional(
        Type.String({ description: 'Cell source content' }),
      ),
    }),
    capability: notebookEditCapability,
    execute: async (
      args: {
        filePath: string;
        action: 'insert_cell' | 'replace_cell' | 'delete_cell' | 'update_cell_source';
        index?: number;
        cellType?: 'code' | 'markdown' | 'raw';
        source?: string;
      },
      ctx,
    ) => {
      try {
        const resolvedPath = path.resolve(ctx.cwd, args.filePath);

        // Read the file
        let raw: string;
        try {
          raw = fs.readFileSync(resolvedPath, 'utf-8');
        } catch {
          return errorResult(`File not found: ${args.filePath}`);
        }

        // Parse JSON
        let notebook: unknown;
        try {
          notebook = JSON.parse(raw);
        } catch {
          return errorResult(`File is not valid JSON: ${args.filePath}`);
        }

        // Validate notebook structure
        const nb = notebook as Record<string, unknown>;
        if (!nb || typeof nb !== 'object' || !Array.isArray(nb.cells)) {
          return errorResult(
            `File is not a valid .ipynb notebook (missing cells array): ${args.filePath}`,
          );
        }

        const notebookData = nb as unknown as Notebook;
        const cells = notebookData.cells;

        switch (args.action) {
          case 'insert_cell': {
            if (!args.cellType) {
              return errorResult('cellType is required for insert_cell action');
            }
            if (args.source === undefined || args.source === null) {
              return errorResult('source is required for insert_cell action');
            }
            const newCell: NotebookCell = {
              cell_type: args.cellType,
              source: sourceToLines(args.source),
              metadata: {},
            };
            if (args.cellType === 'code') {
              newCell.outputs = [];
              newCell.execution_count = null;
            }
            const insertIdx =
              args.index !== undefined ? args.index : cells.length;
            cells.splice(insertIdx, 0, newCell);
            break;
          }

          case 'replace_cell': {
            if (args.index === undefined) {
              return errorResult('index is required for replace_cell action');
            }
            if (args.index < 0 || args.index >= cells.length) {
              return errorResult(
                `Cell index ${args.index} out of range (cells: ${cells.length})`,
              );
            }
            if (!args.cellType) {
              return errorResult('cellType is required for replace_cell action');
            }
            if (args.source === undefined || args.source === null) {
              return errorResult('source is required for replace_cell action');
            }
            const newCell: NotebookCell = {
              cell_type: args.cellType,
              source: sourceToLines(args.source),
              metadata: {},
            };
            if (args.cellType === 'code') {
              newCell.outputs = [];
              newCell.execution_count = null;
            }
            cells[args.index] = newCell;
            break;
          }

          case 'delete_cell': {
            if (args.index === undefined) {
              return errorResult('index is required for delete_cell action');
            }
            if (args.index < 0 || args.index >= cells.length) {
              return errorResult(
                `Cell index ${args.index} out of range (cells: ${cells.length})`,
              );
            }
            cells.splice(args.index, 1);
            break;
          }

          case 'update_cell_source': {
            if (args.index === undefined) {
              return errorResult(
                'index is required for update_cell_source action',
              );
            }
            if (args.index < 0 || args.index >= cells.length) {
              return errorResult(
                `Cell index ${args.index} out of range (cells: ${cells.length})`,
              );
            }
            if (args.source === undefined || args.source === null) {
              return errorResult(
                'source is required for update_cell_source action',
              );
            }
            // Preserve outputs, execution_count, metadata — only update source
            cells[args.index].source = sourceToLines(args.source);
            break;
          }

          default:
            return errorResult(
              `Unknown action: ${(args as any).action}. Supported: insert_cell, replace_cell, delete_cell, update_cell_source`,
            );
        }

        // Write back
        fs.writeFileSync(
          resolvedPath,
          JSON.stringify(notebookData, null, 2),
          'utf-8',
        );
        return textResult(
          `Successfully performed ${args.action} on ${resolvedPath}`,
        );
      } catch (err: any) {
        return errorResult(
          `Failed to edit notebook: ${err.message ?? String(err)}`,
        );
      }
    },
  };
}
