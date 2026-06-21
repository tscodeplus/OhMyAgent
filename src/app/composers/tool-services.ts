import type { AppConfig, AppServices } from '../types.js';
import type { AgentFactory } from '../../agent/agent-factory.js';
import { ToolRegistryImpl } from '../../tools/registry.js';
import { ToolPlatformRegistryImpl } from '../../tools/platform/registry.js';
import { AgentToolAdapterImpl } from '../../tools/platform/agent-tool-adapter.js';
import { PolicyCenterImpl } from '../../policy/policy-center.js';
import { configEventBus } from '../config-event-bus.js';
import { createShellTool } from '../../tools/builtins/shell-tool.js';
import { createFileReadTool } from '../../tools/builtins/file-read-tool.js';
import { createFileSearchTool } from '../../tools/builtins/file-search-tool.js';
import { createMemoryRecallTool } from '../../tools/builtins/memory-recall-tool.js';
import { createMemoryStoreTool, createDefaultMemoryFilter } from '../../tools/builtins/memory-store-tool.js';
import { createSessionSummarizeTool } from '../../tools/builtins/session-summarize-tool.js';
import { createShellToolDefinition } from '../../tools/builtins/shell/definition.js';
import { createFileReadToolDefinition } from '../../tools/builtins/files/read-definition.js';
import { createFileSearchToolDefinition } from '../../tools/builtins/files/search-definition.js';
import { createMemoryRecallToolDefinition } from '../../tools/builtins/memory/recall-definition.js';
import { createMemoryStoreToolDefinition } from '../../tools/builtins/memory/store-definition.js';
import { createMemoryListToolDefinition } from '../../tools/builtins/memory/list-definition.js';
import { createMemoryDeleteToolDefinition } from '../../tools/builtins/memory/delete-definition.js';
import { createMemoryUpdateToolDefinition } from '../../tools/builtins/memory/update-definition.js';
import { createPersonaAuditToolDefinition } from '../../tools/builtins/memory/persona-audit-definition.js';
import { createPersonaRebuildToolDefinition } from '../../tools/builtins/memory/persona-rebuild-definition.js';
import { createMemoryDoctorToolDefinition } from '../../tools/builtins/memory/doctor-definition.js';
import { createMemoryCompactToolDefinition } from '../../tools/builtins/memory/compact-definition.js';
import { createSessionSummarizeToolDefinition } from '../../tools/builtins/session/definition.js';
import { createComputerUseToolDefinition } from '../../tools/builtins/computer-use/definition.js';
import { createSpawnAgentToolDefinition } from '../../tools/builtins/agents/spawn-definition.js';
import { createPlanAndSpawnToolDefinition } from '../../tools/builtins/agents/plan-spawn-definition.js';
import { createFileWriteToolDefinition } from '../../tools/builtins/files/write-definition.js';
import { createFileEditToolDefinition } from '../../tools/builtins/files/edit-definition.js';
import { createGlobToolDefinition } from '../../tools/builtins/files/glob-definition.js';
import { createGrepToolDefinition } from '../../tools/builtins/files/grep-definition.js';
import { createWebFetchToolDefinition } from '../../tools/builtins/web/fetch-definition.js';
import { createToolSearchToolDefinition } from '../../tools/builtins/session/tool-search-definition.js';
import { createAskUserQuestionToolDefinition } from '../../tools/builtins/session/ask-definition.js';
import { createBriefToolDefinition } from '../../tools/builtins/session/brief-definition.js';
import { createTodoWriteToolDefinition } from '../../tools/builtins/session/todo-definition.js';
import { createSleepToolDefinition } from '../../tools/builtins/shell/sleep-definition.js';
import { createConfigToolDefinition } from '../../tools/builtins/config/config-definition.js';
import { createImageToTextToolDefinition } from '../../tools/builtins/multimodal/image-to-text-definition.js';
import { createSpeechToTextToolDefinition } from '../../tools/builtins/multimodal/speech-to-text-definition.js';
import { createRemoteTriggerToolDefinition } from '../../tools/builtins/web/remote-trigger-definition.js';
import { createImageGenerationToolDefinition } from '../../tools/builtins/multimodal/image-generation-definition.js';
import { createVideoGenerationToolDefinition } from '../../tools/builtins/multimodal/video-generation-definition.js';
import { createImageGenerationProvider, createVideoGenerationProvider } from '../../provider/image-generation/index.js';
import { createTaskCreateToolDefinition } from '../../tools/builtins/tasks/create-definition.js';
import { createTaskGetToolDefinition } from '../../tools/builtins/tasks/get-definition.js';
import { createTaskListToolDefinition } from '../../tools/builtins/tasks/list-definition.js';
import { createTaskStopToolDefinition } from '../../tools/builtins/tasks/stop-definition.js';
import { createTaskOutputToolDefinition } from '../../tools/builtins/tasks/output-definition.js';
import { createTaskUpdateToolDefinition } from '../../tools/builtins/tasks/update-definition.js';
import { createSendMessageToolDefinition } from '../../tools/builtins/tasks/send-message-definition.js';
import { createTeamCreateToolDefinition } from '../../tools/builtins/tasks/team-create-definition.js';
import { createTeamDeleteToolDefinition } from '../../tools/builtins/tasks/team-delete-definition.js';
import { createEnterPlanModeToolDefinition } from '../../tools/builtins/session/enter-plan-definition.js';
import { createExitPlanModeToolDefinition } from '../../tools/builtins/session/exit-plan-definition.js';
import { createEnterWorktreeToolDefinition } from '../../tools/builtins/session/enter-worktree-definition.js';
import { createExitWorktreeToolDefinition } from '../../tools/builtins/session/exit-worktree-definition.js';
import { createDownloadFileToolDefinition } from '../../tools/builtins/files/download-definition.js';
import { AgentManager } from '../../agent/agent-manager.js';
import { OrchestratorImpl } from '../../orchestrator/orchestrator.js';
import { ComputerUseHost } from '../../computer-use/computer-host.js';
import type { MemoryServices } from './memory-services.js';
import type { MemoryChangeEvent } from '../../memory/memory-writer.js';

export interface ToolServices {
  toolRegistry: ToolRegistryImpl;
  toolPlatformRegistry: ToolPlatformRegistryImpl;
  memoryFilter: ReturnType<typeof createDefaultMemoryFilter>;
}

export function createToolServices(input: {
  config: AppConfig;
  logger: AppServices['logger'];
  memory: MemoryServices;
  policyCenter: PolicyCenterImpl;
  servicesRef: { current?: AppServices };
}): ToolServices {
  const { config, logger, memory, policyCenter, servicesRef } = input;
  const toolRegistry = new ToolRegistryImpl();
  toolRegistry.register(createShellTool({
    timeoutMs: config.tools.defaultTimeoutMs,
    maxOutputLength: config.tools.maxOutputLength,
  }));
  toolRegistry.register(createFileReadTool({ config, policyCenter }));
  toolRegistry.register(createFileSearchTool({
    allowedRoots: config.tools.fileRead.allowedRoots.length > 0
      ? config.tools.fileRead.allowedRoots : undefined,
    deniedPatterns: config.tools.fileRead.deniedPatterns.length > 0
      ? config.tools.fileRead.deniedPatterns : undefined,
  }));

  const memoryFilter = createDefaultMemoryFilter();
  toolRegistry.register(createMemoryRecallTool({ memoryRetriever: memory.memoryRetriever, logger }));
  toolRegistry.register(createMemoryStoreTool({ memoryWriter: memory.memoryWriter, memoryFilter }));
  toolRegistry.register(createSessionSummarizeTool({
    memorySummarizer: memory.memorySummarizer,
    sessionRepository: memory.sessionRepository,
    messageRepository: memory.messageRepository,
    episodeRepository: memory.episodeRepository,
  }));

  const agentToolAdapter = new AgentToolAdapterImpl({
    policyCenter,
    getServices: () => servicesRef.current,
  });
  const toolPlatformRegistry = new ToolPlatformRegistryImpl(toolRegistry, agentToolAdapter);

  // Re-register shell tool definition on config reload (timeout/output limits)
  configEventBus.onReload((c) => {
    toolPlatformRegistry.registerDefinition(createShellToolDefinition({
      timeoutMs: c.tools.defaultTimeoutMs,
      maxOutputLength: c.tools.maxOutputLength,
    }));
  });

  return {
    toolRegistry,
    toolPlatformRegistry,
    memoryFilter,
  };
}

export function registerV4ToolDefinitions(input: {
  config: AppConfig;
  logger: AppServices['logger'];
  tools: ToolServices;
  memory: MemoryServices;
  policyCenter: PolicyCenterImpl;
  computerUseHost?: ComputerUseHost;
  agentManager: AgentManager;
  agentFactory: AgentFactory;
  orchestrator: OrchestratorImpl;
}): void {
  const { config, logger, tools, memory, policyCenter, computerUseHost, agentManager, agentFactory, orchestrator } = input;
  const { toolPlatformRegistry, memoryFilter } = tools;

  toolPlatformRegistry.registerDefinition(createShellToolDefinition({
    timeoutMs: config.tools.defaultTimeoutMs,
    maxOutputLength: config.tools.maxOutputLength,
  }));
  toolPlatformRegistry.registerDefinition(createFileReadToolDefinition({ config, policyCenter }));
  toolPlatformRegistry.registerDefinition(createFileSearchToolDefinition({
    allowedRoots: config.tools.fileRead.allowedRoots.length > 0
      ? config.tools.fileRead.allowedRoots : undefined,
    deniedPatterns: config.tools.fileRead.deniedPatterns.length > 0
      ? config.tools.fileRead.deniedPatterns : undefined,
  }));
  toolPlatformRegistry.registerDefinition(createMemoryRecallToolDefinition({ memoryRetriever: memory.memoryRetriever, logger }));
  toolPlatformRegistry.registerDefinition(createMemoryStoreToolDefinition({ memoryWriter: memory.memoryWriter, memoryFilter }));
  toolPlatformRegistry.registerDefinition(createMemoryListToolDefinition({ memoryRepository: memory.memoryRepository }));
  const onMemoryChanged = (event?: MemoryChangeEvent) => memory.memoryChangeCallbacks.forEach(cb => cb(event));
  toolPlatformRegistry.registerDefinition(createPersonaAuditToolDefinition({ auditService: memory.personaAuditService }));
  if (memory.personaDistiller) {
    toolPlatformRegistry.registerDefinition(createPersonaRebuildToolDefinition({ personaDistiller: memory.personaDistiller }));
  }
  toolPlatformRegistry.registerDefinition(createMemoryDoctorToolDefinition({ doctor: memory.memoryDoctor }));
  toolPlatformRegistry.registerDefinition(createMemoryCompactToolDefinition({ memoryRepository: memory.memoryRepository }));
  toolPlatformRegistry.registerDefinition(createMemoryDeleteToolDefinition({
    memoryRepository: memory.memoryRepository,
    embeddingRepository: memory.embeddingRepository,
    memoryLinkRepository: memory.memoryLinkRepo,
    onMemoryChanged,
  }));
  toolPlatformRegistry.registerDefinition(createMemoryUpdateToolDefinition({
    memoryRepository: memory.memoryRepository,
    embeddingRepository: memory.embeddingRepository,
    embeddingClient: memory.embeddingClient,
    onMemoryChanged,
  }));
  toolPlatformRegistry.registerDefinition(createSessionSummarizeToolDefinition({
    memorySummarizer: memory.memorySummarizer,
    sessionRepository: memory.sessionRepository,
    messageRepository: memory.messageRepository,
    episodeRepository: memory.episodeRepository,
  }));

  if (computerUseHost) {
    toolPlatformRegistry.registerDefinition(createComputerUseToolDefinition(computerUseHost, () => ({
      sessionPath: undefined,
      agentId: undefined,
    })));
  }

  toolPlatformRegistry.registerDefinition(createSpawnAgentToolDefinition({
    agentManager,
    logger,
    orchestrator,
    createAgent: (config, task, childOptions) => agentFactory.create({
      agentId: config.id,
      systemPrompt: config.system_prompt,
      tools: agentManager.resolveTools(config).filter((t: any) => t.name !== 'spawn_agent'),
      message: task,
      sessionId: childOptions?.sessionId,
      toolsProfileOverride: config.tools.profile,
      policyScope: childOptions?.policyScope,
      policyAgentId: childOptions?.agentId,
      computerUseAllowed: childOptions?.policyScope?.computerUseEnabled,
      isChildAgent: true,
      childTaskDescription: task,
    }),
  }));

  // P4: plan_and_spawn — structured plan + batch spawn with DAG execution
  toolPlatformRegistry.registerDefinition(createPlanAndSpawnToolDefinition({
    agentManager,
    orchestrator,
    logger,
    maxConcurrency: config.smart_agent_team.max_children,
    timeoutMs: 300_000,
    createAgent: (config: any, task: string, childOptions: any) => agentFactory.create({
      agentId: config.id,
      systemPrompt: config.system_prompt,
      tools: agentManager.resolveTools(config).filter((t: any) => t.name !== 'spawn_agent'),
      message: task,
      sessionId: childOptions?.sessionId,
      toolsProfileOverride: config.tools.profile,
      policyScope: childOptions?.policyScope,
      policyAgentId: childOptions?.agentId,
      computerUseAllowed: childOptions?.policyScope?.computerUseEnabled,
      isChildAgent: true,
      childTaskDescription: task,
    }),
  }));

  toolPlatformRegistry.registerDefinition(createFileWriteToolDefinition());
  toolPlatformRegistry.registerDefinition(createFileEditToolDefinition());
  toolPlatformRegistry.registerDefinition(createGlobToolDefinition());
  toolPlatformRegistry.registerDefinition(createGrepToolDefinition());
  toolPlatformRegistry.registerDefinition(createWebFetchToolDefinition());
  toolPlatformRegistry.registerDefinition(createToolSearchToolDefinition());
  toolPlatformRegistry.registerDefinition(createAskUserQuestionToolDefinition());
  toolPlatformRegistry.registerDefinition(createBriefToolDefinition());
  toolPlatformRegistry.registerDefinition(createTodoWriteToolDefinition());
  toolPlatformRegistry.registerDefinition(createSleepToolDefinition());
  toolPlatformRegistry.registerDefinition(createConfigToolDefinition());
  toolPlatformRegistry.registerDefinition(createTaskCreateToolDefinition());
  toolPlatformRegistry.registerDefinition(createTaskGetToolDefinition());
  toolPlatformRegistry.registerDefinition(createTaskListToolDefinition());
  toolPlatformRegistry.registerDefinition(createTaskStopToolDefinition());
  toolPlatformRegistry.registerDefinition(createTaskOutputToolDefinition());
  toolPlatformRegistry.registerDefinition(createTaskUpdateToolDefinition());
  toolPlatformRegistry.registerDefinition(createSendMessageToolDefinition());
  toolPlatformRegistry.registerDefinition(createTeamCreateToolDefinition());
  toolPlatformRegistry.registerDefinition(createTeamDeleteToolDefinition());
  toolPlatformRegistry.registerDefinition(createEnterPlanModeToolDefinition());
  toolPlatformRegistry.registerDefinition(createExitPlanModeToolDefinition());
  toolPlatformRegistry.registerDefinition(createEnterWorktreeToolDefinition());
  toolPlatformRegistry.registerDefinition(createExitWorktreeToolDefinition());
  toolPlatformRegistry.registerDefinition(createImageToTextToolDefinition());
  toolPlatformRegistry.registerDefinition(createSpeechToTextToolDefinition());
  toolPlatformRegistry.registerDefinition(createRemoteTriggerToolDefinition());
  toolPlatformRegistry.registerDefinition(createImageGenerationToolDefinition(createImageGenerationProvider(config)));
  toolPlatformRegistry.registerDefinition(createVideoGenerationToolDefinition(createVideoGenerationProvider(config)));
  toolPlatformRegistry.registerDefinition(createDownloadFileToolDefinition());
}
