import path from 'path';
import { defineConfig } from 'vitest/config';

/**
 * Smoke suite for the WebUI HTTP surface.
 *
 * Separate from vitest.config.ts because these specs talk to a **live** server
 * over fetch (they are named *.spec.ts so the unit config never collects them,
 * which also meant nothing ever ran them). Start the gateway first:
 *
 *   pnpm dev &
 *   OHMYAGENT_PORT=9191 WEBUI_TOKEN=… pnpm test:smoke:webui
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: '@earendil-works/pi-ai/compat', replacement: path.resolve(__dirname, 'src/pi-mono/ai/compat.ts') },
      { find: '@earendil-works/pi-ai', replacement: path.resolve(__dirname, 'src/pi-mono/ai/compat.ts') },
      { find: '@earendil-works/pi-agent-core', replacement: path.resolve(__dirname, 'src/pi-mono/agent/index.ts') },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/webui/**/*.spec.ts'],
    testTimeout: 10000,
  },
});
