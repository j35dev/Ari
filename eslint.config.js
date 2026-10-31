import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  // `.ari/worktrees/<sessionId>` and `.worktrees/<task>` hold whole checkouts of
  // this repo — a session worktree or a fleet worktree. Without these, `eslint .`
  // walks into a second copy of every source file the moment a session runs.
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/node_modules/**',
      '**/coverage/**',
      '.ari/**',
      '.worktrees/**',
      '.claude/worktrees/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // The service worker runs in a worker global scope, which the Node and
    // browser globals the rest of the repo assumes do not describe.
    files: ['apps/mobile/public/sw.js'],
    languageOptions: {
      globals: { self: 'readonly', caches: 'readonly', fetch: 'readonly', Response: 'readonly', URL: 'readonly' },
    },
  },
  {
    files: ['scripts/**'],
    languageOptions: { globals: { Buffer: 'readonly', console: 'readonly', process: 'readonly' } },
  },
  {
    files: ['**/*.test.{ts,tsx}'],
    rules: {
      // Test doubles implement async interfaces without awaiting.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // One type-aware program for all of apps/desktop, tests included, peaks near
  // the 6GB macOS runner cap. Main and the renderer do not import each other,
  // so each gets its own program. Tests stay out of those programs; tsc still
  // typechecks them.
  {
    files: [
      'apps/desktop/src/main/**/*.ts',
      'apps/desktop/src/preload/**/*.ts',
      'apps/desktop/src/shared/**/*.ts',
      'apps/desktop/src/test-setup.dom.ts',
      'apps/desktop/electron.vite.config.ts',
      'apps/desktop/vitest.config.ts',
    ],
    ignores: ['apps/desktop/**/*.test.ts', 'apps/desktop/**/*.live.test.ts'],
    languageOptions: {
      parserOptions: {
        project: ['./apps/desktop/tsconfig.eslint-main.json'],
        projectService: false,
      },
    },
  },
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}', 'apps/desktop/src/assets.d.ts'],
    ignores: ['apps/desktop/**/*.test.ts', 'apps/desktop/**/*.test.tsx'],
    languageOptions: {
      parserOptions: {
        project: ['./apps/desktop/tsconfig.eslint-renderer.json'],
        projectService: false,
      },
    },
  },
  {
    files: [
      'apps/desktop/**/*.test.ts',
      'apps/desktop/**/*.test.tsx',
      'apps/desktop/**/*.live.test.ts',
    ],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
)
