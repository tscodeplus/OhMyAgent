import path from 'path';
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      '@earendil-works/pi-ai': path.resolve(__dirname, 'src/pi-mono/ai/compat.ts'),
      '@earendil-works/pi-agent-core': path.resolve(__dirname, 'src/pi-mono/agent/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 10000,
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json', 'html'],
      reportsDirectory: './coverage',
      // Measure our own code only. pi-mono is an embedded upstream fork;
      // CLI/eval are operational scripts, not unit-tested logic.
      include: ['src/**/*.ts', 'extensions/**/*.ts'],
      exclude: [
        'src/pi-mono/**',
        'src/cli/**',
        'src/memory/eval/**',
        '**/*.d.ts',
        '**/types.ts',
      ],
      // Baseline set below measured coverage. Ratchet upward over time,
      // never down. CI fails if coverage regresses below these.
      // Current measured: stmts ~53.0% / branches ~73.8% / funcs ~65.1% / lines ~53.0%
      thresholds: {
        statements: 52,
        branches: 72,
        functions: 64,
        lines: 52,
      },
    },
  },
});
