// ── Legacy factory exports (deprecated — use v4 ToolDefinition wrappers below) ──

/** @deprecated Use `createComputerUseToolDefinition` from `./computer-use/definition.js` instead. */
export { createComputerUseTool } from './computer-use-tool.js';
/** @deprecated Use `createMemoryRecallToolDefinition` from `./memory/recall-definition.js` instead. */
export { createMemoryRecallTool } from './memory-recall-tool.js';
/** @deprecated Use `createMemoryStoreToolDefinition` from `./memory/store-definition.js` instead. */
export { createMemoryStoreTool, createDefaultMemoryFilter } from './memory-store-tool.js';
export type { MemoryFilter } from './memory-store-tool.js';

// ── v4 ToolDefinition wrappers (primary export path) ──
export { createShellToolDefinition, shellToolCapability } from './shell/definition.js';
export { createFileReadToolDefinition, fileReadToolCapability } from './files/read-definition.js';
export { createFileSearchToolDefinition, fileSearchToolCapability } from './files/search-definition.js';
export { createMemoryRecallToolDefinition, memoryRecallToolCapability } from './memory/recall-definition.js';
export { createMemoryStoreToolDefinition, memoryStoreToolCapability } from './memory/store-definition.js';
export { createMemoryListToolDefinition, memoryListToolCapability } from './memory/list-definition.js';
export { createMemoryDeleteToolDefinition, memoryDeleteToolCapability } from './memory/delete-definition.js';
export { createMemoryUpdateToolDefinition, memoryUpdateToolCapability } from './memory/update-definition.js';
export { createSessionSummarizeToolDefinition, sessionSummarizeToolCapability } from './session/definition.js';
export { createComputerUseToolDefinition, computerUseToolCapability } from './computer-use/definition.js';
export { createSpawnAgentToolDefinition, spawnAgentToolCapability } from './agents/spawn-definition.js';
export { createFileWriteToolDefinition, fileWriteCapability } from './files/write-definition.js';
export { createFileEditToolDefinition, fileEditCapability } from './files/edit-definition.js';
export { createGlobToolDefinition, globCapability } from './files/glob-definition.js';
export { createGrepToolDefinition, grepCapability } from './files/grep-definition.js';
export { createLspToolDefinition, lspCapability } from './files/lsp-definition.js';
export { createWebFetchToolDefinition, webFetchToolCapability } from './web/fetch-definition.js';
export { createToolSearchToolDefinition, toolSearchToolCapability } from './session/tool-search-definition.js';
export { createAskUserQuestionToolDefinition, askUserQuestionCapability } from './session/ask-definition.js';
export { createBriefToolDefinition, briefCapability } from './session/brief-definition.js';
export { createTodoWriteToolDefinition, todoWriteCapability } from './session/todo-definition.js';
export { createSleepToolDefinition, sleepCapability } from './shell/sleep-definition.js';
export { createConfigToolDefinition, configCapability } from './config/config-definition.js';
export { createImageToTextToolDefinition, imageToTextCapability } from './multimodal/image-to-text-definition.js';

// v4 Task tools (P6-T1)
export { createTaskCreateToolDefinition, taskCreateCapability } from './tasks/create-definition.js';
export { createTaskGetToolDefinition, taskGetCapability } from './tasks/get-definition.js';
export { createTaskListToolDefinition, taskListCapability } from './tasks/list-definition.js';
export { createTaskStopToolDefinition, taskStopCapability } from './tasks/stop-definition.js';
export { createTaskOutputToolDefinition, taskOutputCapability } from './tasks/output-definition.js';
export { createTaskUpdateToolDefinition, taskUpdateCapability } from './tasks/update-definition.js';
export { createSendMessageToolDefinition, sendMessageToolCapability } from './tasks/send-message-definition.js';
export { createTeamCreateToolDefinition, teamCreateCapability } from './tasks/team-create-definition.js';
export { createTeamDeleteToolDefinition, teamDeleteCapability } from './tasks/team-delete-definition.js';
export { createEnterPlanModeToolDefinition, enterPlanModeCapability } from './session/enter-plan-definition.js';
export { createExitPlanModeToolDefinition, exitPlanModeCapability } from './session/exit-plan-definition.js';
export { createEnterWorktreeToolDefinition, enterWorktreeCapability } from './session/enter-worktree-definition.js';
export { createExitWorktreeToolDefinition, exitWorktreeCapability } from './session/exit-worktree-definition.js';
// v4 Cron tools (F2)
export { createCronCreateToolDefinition, cronCreateCapability } from './cron/create-definition.js';
export { createCronListToolDefinition, cronListCapability } from './cron/list-definition.js';
export { createCronDeleteToolDefinition, cronDeleteCapability } from './cron/delete-definition.js';
export { createCronToggleToolDefinition, cronToggleCapability } from './cron/toggle-definition.js';

// v4 Web tools (F2)
export { createRemoteTriggerToolDefinition, remoteTriggerCapability } from './web/remote-trigger-definition.js';

// v4 File tools (F2)
export { createNotebookEditToolDefinition, notebookEditCapability } from './files/notebook-edit-definition.js';

// v4 Multimodal tools (F2)
export { createImageGenerationToolDefinition, imageGenerationCapability } from './multimodal/image-generation-definition.js';
export { createVideoGenerationToolDefinition, videoGenerationCapability } from './multimodal/video-generation-definition.js';
