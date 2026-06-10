import type { Logger } from 'pino';
import type { AgentTool } from '../pi-mono/agent/types.js';
import type { ToolDefinition } from '../tools/platform/tool-definition.js';
import type { ToolPlatformRegistry } from '../tools/platform/registry.js';
import type { ExtensionAPI, ExtensionHooks, CommandHandler, LoadedExtension } from './types.js';
import type { ChannelAdapter } from '../channel/types.js';
import type { AppConfig, ToolRegistry } from '../app/types.js';
import type { ExtensionManager } from './extension-manager.js';
import type { CommandRegistry } from '../commands/command-registry.js';
import type { ResolvedAgentConfig } from '../agent/config-types.js';

export interface ExtensionAPIDeps {
  toolRegistry: ToolRegistry;
  toolPlatformRegistry: ToolPlatformRegistry;
  commandRegistry: CommandRegistry;
  extensionManager: ExtensionManager;
  hooks: ExtensionHooks[];  // shared mutable array
  config: AppConfig;
  logger: Logger;
  services: Map<string, unknown>;
}

export function createExtensionAPI(deps: ExtensionAPIDeps): ExtensionAPI {
  return {
    registerTool(tool: AgentTool<any>): void {
      deps.toolRegistry.register(tool);
      deps.logger.debug({ toolName: tool.name }, 'Extension registered tool');
    },

    registerToolDefinition(def: ToolDefinition): void {
      deps.toolPlatformRegistry.registerDefinition(def);
      deps.logger.debug({ toolName: def.name }, 'Extension registered tool definition');
    },

    unregisterTool(name: string): void {
      deps.toolRegistry.unregister(name);
      deps.logger.debug({ toolName: name }, 'Extension unregistered tool');
    },

    registerCommand(name: string, handler: CommandHandler): void {
      deps.commandRegistry.register(name, handler);
      deps.logger.debug({ commandName: name }, 'Extension registered command');
    },

    registerChannel(adapter: ChannelAdapter): void {
      deps.extensionManager.registerChannel(adapter);
    },

    registerHook(hooks: ExtensionHooks): void {
      deps.hooks.push(hooks);
      deps.logger.debug('Extension registered hooks');
    },

    getService<T>(name: string): T | undefined {
      return deps.services.get(name) as T | undefined;
    },

    getConfig(): AppConfig {
      return deps.config;
    },

    getLogger(): Logger {
      return deps.logger;
    },
  };
}
