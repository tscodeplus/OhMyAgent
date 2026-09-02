import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'ui/**',
      'desktop/**',
      'skills/**',
      'data/**',
      // Vendored pi-mono fork — replaced wholesale on upgrades, so local lint
      // findings here can never be fixed durably.
      'src/pi-mono/**',
      '**/*.d.ts',
    ],
  },
  {
    files: ['src/**/*.ts', 'extensions/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      // src/index.ts turns any unhandled rejection into process.exit(1), so an
      // unawaited promise is a gateway outage rather than a style issue.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
);
