import path from 'path';
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
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
      // Current measured: stmts/lines 59.9% / branches 75.6% / funcs 70.5%
      //
      // The glob keys are enforced per group on top of the global ones. The
      // global average alone is satisfiable while one area sits at zero — that
      // is exactly how src/app/webui reached 2.5% statement coverage.
      thresholds: {
        statements: 56,
        branches: 72,
        functions: 67,
        lines: 56,
        // Measured 18.5% / 68.0% after the route harness landed here.
        'src/app/webui/**': { statements: 18, branches: 65 },
        // Measured 86.7% / 82.7%. This is approval gating — a coverage
        // regression in it is a security boundary going untested.
        'src/policy/**': { statements: 85, branches: 80 },
      },
    },
  },
});
