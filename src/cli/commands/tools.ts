/**
 * ohmyagent tools lint
 *
 * P6: lints builtin tool definitions for description/naming orthogonality —
 * empty descriptions (error), >2 sentences, over-length, non-verb-start and
 * near-duplicate descriptions (warnings). Mirrors the skill linter; see
 * src/tools/tool-linter.ts.
 *
 * Usage:
 *   ohmyagent tools lint      Lint all builtin tool definitions
 */

import {
  lintToolDescriptions,
  type ToolLintReport,
} from '../../tools/tool-linter.js';

type DefinitionCtor = () => Promise<{ name: string; description: string }>;

async function loadBuiltinDefinitions(): Promise<{ name: string; description: string }[]> {
  // Direct imports (not the runtime registry) so the CLI works without
  // booting services. Keep in sync with tests/tools/v4-tool-surface.test.ts.
  const ctors: DefinitionCtor[] = [
    () => import('../../tools/builtins/shell/definition.js').then((m) => m.createShellToolDefinition()),
    () => import('../../tools/builtins/files/write-definition.js').then((m) => m.createFileWriteToolDefinition()),
    () => import('../../tools/builtins/files/edit-definition.js').then((m) => m.createFileEditToolDefinition()),
    () => import('../../tools/builtins/files/notebook-edit-definition.js').then((m) => m.createNotebookEditToolDefinition()),
    () => import('../../tools/builtins/files/search-definition.js').then((m) => m.createFileSearchToolDefinition()),
    () => import('../../tools/builtins/files/glob-definition.js').then((m) => m.createGlobToolDefinition()),
    () => import('../../tools/builtins/files/grep-definition.js').then((m) => m.createGrepToolDefinition()),
    () => import('../../tools/builtins/files/lsp-definition.js').then((m) => m.createLspToolDefinition()),
    () => import('../../tools/builtins/web/fetch-definition.js').then((m) => m.createWebFetchToolDefinition()),
    () => import('../../tools/builtins/web/remote-trigger-definition.js').then((m) => m.createRemoteTriggerToolDefinition()),
    () => import('../../tools/builtins/session/tool-search-definition.js').then((m) => m.createToolSearchToolDefinition()),
    () => import('../../tools/builtins/session/ask-definition.js').then((m) => m.createAskUserQuestionToolDefinition()),
    () => import('../../tools/builtins/session/brief-definition.js').then((m) => m.createBriefToolDefinition()),
    () => import('../../tools/builtins/config/config-definition.js').then((m) => m.createConfigToolDefinition()),
    () => import('../../tools/builtins/shell/sleep-definition.js').then((m) => m.createSleepToolDefinition()),
    () => import('../../tools/builtins/session/todo-definition.js').then((m) => m.createTodoWriteToolDefinition()),
    () => import('../../tools/builtins/session/enter-plan-definition.js').then((m) => m.createEnterPlanModeToolDefinition()),
    () => import('../../tools/builtins/session/exit-plan-definition.js').then((m) => m.createExitPlanModeToolDefinition()),
    () => import('../../tools/builtins/session/enter-worktree-definition.js').then((m) => m.createEnterWorktreeToolDefinition()),
    () => import('../../tools/builtins/session/exit-worktree-definition.js').then((m) => m.createExitWorktreeToolDefinition()),
    () => import('../../tools/builtins/tasks/create-definition.js').then((m) => m.createTaskCreateToolDefinition()),
    () => import('../../tools/builtins/tasks/get-definition.js').then((m) => m.createTaskGetToolDefinition()),
    () => import('../../tools/builtins/tasks/list-definition.js').then((m) => m.createTaskListToolDefinition()),
    () => import('../../tools/builtins/tasks/stop-definition.js').then((m) => m.createTaskStopToolDefinition()),
    () => import('../../tools/builtins/tasks/output-definition.js').then((m) => m.createTaskOutputToolDefinition()),
    () => import('../../tools/builtins/tasks/update-definition.js').then((m) => m.createTaskUpdateToolDefinition()),
    () => import('../../tools/builtins/tasks/send-message-definition.js').then((m) => m.createSendMessageToolDefinition()),
    () => import('../../tools/builtins/tasks/team-create-definition.js').then((m) => m.createTeamCreateToolDefinition()),
    () => import('../../tools/builtins/tasks/team-delete-definition.js').then((m) => m.createTeamDeleteToolDefinition()),
    () => import('../../tools/builtins/cron/create-definition.js').then((m) => m.createCronCreateToolDefinition()),
    () => import('../../tools/builtins/cron/list-definition.js').then((m) => m.createCronListToolDefinition()),
    () => import('../../tools/builtins/cron/delete-definition.js').then((m) => m.createCronDeleteToolDefinition()),
    () => import('../../tools/builtins/cron/toggle-definition.js').then((m) => m.createCronToggleToolDefinition()),
    () => import('../../tools/builtins/multimodal/image-to-text-definition.js').then((m) => m.createImageToTextToolDefinition()),
    () => import('../../tools/builtins/multimodal/image-generation-definition.js').then((m) => m.createImageGenerationToolDefinition()),
  ];

  const defs = await Promise.all(
    ctors.map(async (ctor) => {
      const def = await ctor();
      return { name: def.name, description: def.description ?? '' };
    }),
  );
  return defs;
}

function printReport(report: ToolLintReport): void {
  console.log(`\nLinted ${report.toolsChecked} tool definitions\n`);

  if (report.errors.length > 0) {
    console.log(`Errors (${report.errors.length}):`);
    for (const issue of report.errors) {
      console.log(`  ✗ [${issue.rule}] ${issue.message}`);
    }
    console.log();
  }

  if (report.warnings.length > 0) {
    console.log(`Warnings (${report.warnings.length}):`);
    for (const issue of report.warnings) {
      const pair = issue.relatedTool ? ` ↔ ${issue.relatedTool}` : '';
      console.log(`  ⚠ [${issue.rule}] ${issue.message}${pair}`);
    }
    console.log();
  }

  if (report.errors.length === 0 && report.warnings.length === 0) {
    console.log('All tool descriptions pass the orthogonality checks.');
  }
}

export async function toolsCommand(action: string): Promise<void> {
  if (action !== 'lint') {
    console.error('用法: ohmyagent tools lint');
    process.exit(1);
  }

  const defs = await loadBuiltinDefinitions();
  const report = lintToolDescriptions(defs);
  printReport(report);

  if (!report.ok) {
    process.exit(1);
  }
}
