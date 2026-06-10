import type { AgentTool } from '../pi-mono/agent/types.js';
import type { ToolDefinition } from '../tools/platform/tool-definition.js';
import type { Logger } from 'pino';
import type { AppConfig } from '../app/types.js';
import type { ResolvedAgentConfig } from '../agent/config-types.js';
import type { ChannelAdapter, ChannelContext } from '../channel/types.js';

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  kind: 'tool' | 'channel' | 'command' | 'hook';
  channel_type?: string;
  main: string;  // default 'index.js'
  description?: string;
}

export interface ExtensionAPI {
  registerTool(tool: AgentTool<any>): void;
  registerToolDefinition(def: ToolDefinition): void;
  unregisterTool(name: string): void;
  registerCommand(name: string, handler: CommandHandler): void;
  registerChannel(adapter: ChannelAdapter): void;
  registerHook(hooks: ExtensionHooks): void;
  getService<T>(name: string): T | undefined;
  getConfig(): AppConfig;
  getLogger(): Logger;
}

export interface ExtensionHooks {
  beforeAgentCreate?(config: ResolvedAgentConfig): ResolvedAgentConfig;
  afterAgentCreate?(agent: any): void | Promise<void>;
  onMessage?(ctx: ChannelContext, next: () => Promise<void>): Promise<void>;
}

export type ExtensionModule = (api: ExtensionAPI) => void | Promise<void>;

export interface LoadedExtension {
  manifest: ExtensionManifest;
  baseDir: string;
  status: 'loaded' | 'error';
  error?: string;
}

// CommandHandler type — takes a CommandContext and returns a CommandResult
export interface CommandContext {
  sessionKey: string;
  args: string;
  deps: any;  // CommandDeps (will be refined later)
  messageId?: string;
  chatId?: string;
}

export interface CommandResult {
  reply?: string;
}

export interface CommandHandler {
  (ctx: CommandContext): Promise<CommandResult | null>;
}
