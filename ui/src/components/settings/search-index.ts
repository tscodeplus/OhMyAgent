export interface SearchEntry {
  tabId: string;
  labelKey: string;
  subTabId?: string;
  contextKey?: string;
}

export const SEARCH_INDEX: SearchEntry[] = [
  // General
  { tabId: 'general', labelKey: 'settings.appearance.theme' },
  { tabId: 'general', labelKey: 'settings.appearance.language' },
  { tabId: 'general', labelKey: 'settings.general.logLevel' },
  { tabId: 'general', labelKey: 'settings.general.showToolCalls' },
  { tabId: 'general', labelKey: 'settings.general.showSkillCalls' },
  { tabId: 'general', labelKey: 'settings.footer.title' },
  { tabId: 'general', labelKey: 'settings.general.advanced' },
  { tabId: 'general', labelKey: 'settings.general.databasePath' },
  { tabId: 'general', labelKey: 'settings.general.rateLimit' },

  // Models - Router sub-tab
  {
    tabId: 'models',
    subTabId: 'router',
    labelKey: 'settings.models.provider',
    contextKey: 'settings.models.subtabs.router',
  },
  {
    tabId: 'models',
    subTabId: 'router',
    labelKey: 'settings.models.model',
    contextKey: 'settings.models.subtabs.router',
  },
  {
    tabId: 'models',
    subTabId: 'router',
    labelKey: 'settings.models.apiKey',
    contextKey: 'settings.models.subtabs.router',
  },
  {
    tabId: 'models',
    subTabId: 'router',
    labelKey: 'settings.models.baseUrl',
    contextKey: 'settings.models.subtabs.router',
  },
  {
    tabId: 'models',
    subTabId: 'router',
    labelKey: 'settings.models.reasoningModel',
    contextKey: 'settings.models.subtabs.router',
  },
  {
    tabId: 'models',
    subTabId: 'router',
    labelKey: 'settings.models.defaultReasoningLevel',
    contextKey: 'settings.models.subtabs.router',
  },
  {
    tabId: 'models',
    subTabId: 'router',
    labelKey: 'settings.models.fallbackModels',
    contextKey: 'settings.models.subtabs.router',
  },

  // Models - Auxiliary sub-tab
  {
    tabId: 'models',
    subTabId: 'auxiliary',
    labelKey: 'settings.models.embeddingTitle',
    contextKey: 'settings.models.subtabs.auxiliary',
  },
  {
    tabId: 'models',
    subTabId: 'auxiliary',
    labelKey: 'settings.models.memoryAuxModels',
    contextKey: 'settings.models.subtabs.auxiliary',
  },

  // Models - Providers sub-tab
  {
    tabId: 'models',
    subTabId: 'providers',
    labelKey: 'settings.groups.subscriptions',
    contextKey: 'settings.models.subtabs.subscription',
  },
  {
    tabId: 'models',
    subTabId: 'providers',
    labelKey: 'settings.models.customProviders',
    contextKey: 'settings.models.subtabs.providers',
  },

  // Agents
  { tabId: 'agents', labelKey: 'settings.agents.title' },

  // Harness
  { tabId: 'harness', labelKey: 'settings.groups.harness' },
  { tabId: 'harness', labelKey: 'settings.harness.interactive.enabled' },
  { tabId: 'harness', labelKey: 'settings.harness.interactive.channels.title' },
  { tabId: 'harness', labelKey: 'settings.harness.interactive.trigger.title' },
  { tabId: 'harness', labelKey: 'settings.harness.interactive.approval.title' },
  { tabId: 'harness', labelKey: 'settings.harness.interactive.proposal.title' },

  // Channels
  { tabId: 'channels', labelKey: 'settings.channels.title' },
  { tabId: 'channels', labelKey: 'settings.channels.feishu' },
  { tabId: 'channels', labelKey: 'settings.channels.telegram' },
  { tabId: 'channels', labelKey: 'settings.channels.wechat' },
  { tabId: 'channels', labelKey: 'settings.channels.qq' },

  // Tools
  { tabId: 'tools', labelKey: 'settings.groups.toolsPolicy' },
  { tabId: 'tools', labelKey: 'settings.tools.title' },

  // Web Search
  { tabId: 'websearch', labelKey: 'settings.websearch.title' },

  // Memory
  { tabId: 'memory', labelKey: 'settings.memory.title' },

  // Multimodal
  { tabId: 'multimodal', labelKey: 'settings.multimodal.title' },
  { tabId: 'multimodal', labelKey: 'settings.multimodal.image' },
  { tabId: 'multimodal', labelKey: 'settings.multimodal.imageGeneration' },
  { tabId: 'multimodal', labelKey: 'settings.multimodal.videoGeneration' },
  { tabId: 'multimodal', labelKey: 'settings.multimodal.stt' },

  // Computer Use
  { tabId: 'computer', labelKey: 'settings.computer.title' },

  // Gateway
  { tabId: 'gateway', labelKey: 'settings.gateway.title' },

  // About
  { tabId: 'about', labelKey: 'settings.groups.about' },
];
