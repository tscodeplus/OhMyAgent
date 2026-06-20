// ---------------------------------------------------------------------------
// v4 ToolDefinition for the file_edit tool
// ---------------------------------------------------------------------------

import { Type } from 'typebox';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { textResult, errorResult } from '../../platform/tool-result.js';
import { writeFileNoFollow } from '../../../shared/safe-fs.js';

export const fileEditCapability: ToolCapabilityDescriptor = {
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

export function createFileEditToolDefinition(): ToolDefinition {
  return {
    name: 'file_edit',
    label: 'File Edit',
    description:
      'Edit a file by finding and replacing text. Supports single or replace-all mode.',
    category: 'file',
    parametersSchema: Type.Object({
      filePath: Type.String({
        description: 'The file path to edit',
      }),
      oldString: Type.String({
        description: 'The text to find and replace',
      }),
      newString: Type.String({
        description: 'The replacement text',
      }),
      replaceAll: Type.Optional(
        Type.Boolean({
          description:
            'Replace all occurrences if true; otherwise replace only the first',
        }),
      ),
    }),
    capability: fileEditCapability,
    execute: async (
      args: {
        filePath: string;
        oldString: string;
        newString: string;
        replaceAll?: boolean;
      },
      ctx,
    ) => {
      try {
        const resolvedPath = ctx.resolvedPath ?? path.resolve(ctx.cwd, args.filePath);

        // Read the file
        const content = fs.readFileSync(resolvedPath, 'utf-8');

        // Count occurrences
        const occurrences = content.split(args.oldString).length - 1;

        if (occurrences === 0) {
          return errorResult(
            `The string "${args.oldString}" was not found in ${resolvedPath}`,
          );
        }

        if (occurrences > 1 && !args.replaceAll) {
          // Find line numbers where the string occurs
          const lines = content.split('\n');
          const lineNumbers: number[] = [];
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(args.oldString)) {
              lineNumbers.push(i + 1);
            }
          }
          return errorResult(
            `The string "${args.oldString}" appears ${occurrences} times in ${resolvedPath} at lines ${lineNumbers.join(', ')}. Set replaceAll=true to replace all occurrences.`,
          );
        }

        // Perform the replacement
        let newContent: string;
        if (args.replaceAll) {
          newContent = content.split(args.oldString).join(args.newString);
        } else {
          newContent = content.replace(args.oldString, args.newString);
        }

        // Write back (symlink-safe: O_NOFOLLOW closes the check→write TOCTOU gap).
        writeFileNoFollow(resolvedPath, newContent);
        return textResult(
          `Successfully replaced ${occurrences} occurrence(s) in ${resolvedPath}`,
        );
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return errorResult(`File not found: ${args.filePath}`);
        }
        return errorResult(
          `Failed to edit file: ${err.message ?? String(err)}`,
        );
      }
    },
  };
}
