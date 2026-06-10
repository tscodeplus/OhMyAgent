import type { ExtensionAPI } from '../../src/extensions/types.js';
import { createWebSearchTool } from './web-search-tool.js';

export default function (api: ExtensionAPI) {
  api.registerToolDefinition(createWebSearchTool());
  api.getLogger().info('web-search tool registered');
}
