import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '.redline/**', 'fixtures/**', 'examples/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Run on the TS 6 API (see .pnpmfile.cjs), which disagrees with tsc 7 on some assertions; tsc is the source of truth.
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/consistent-type-definitions': 'off',
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 75, skipBlankLines: true, skipComments: true }],
      complexity: ['error', 15],
      'max-depth': ['error', 4],
      'max-params': ['error', 4],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
      'no-var': 'error',
      'prefer-const': 'error',
      curly: ['error', 'multi-line'],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      // noUncheckedIndexedAccess already forces handling of undefined; `!` after a checked lookup is idiomatic here.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // `||` on strings/numbers deliberately treats '' and 0 as absent.
      '@typescript-eslint/prefer-nullish-coalescing': ['error', { ignorePrimitives: { string: true, number: true, boolean: true } }],
      // Node event handlers (http, process) are async by convention and catch internally.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs', '*.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['**/test/**/*.ts'],
    rules: {
      'max-lines': 'off',
      'max-lines-per-function': 'off',
      complexity: 'off',
      'max-params': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
);
