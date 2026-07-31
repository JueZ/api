import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: ['.angular/**', '.codex/**', 'coverage/**', 'dist/**', 'node_modules/**', 'ops/release-ledger/**'],
  },
  {
    ...js.configs.recommended,
    files: ['scripts/**/*.js', 'scripts/**/*.mjs', 'apps/**/*.mjs'],
    languageOptions: {
      ...js.configs.recommended.languageOptions,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-console': 'off',
    },
  },
  ...tseslint.configs.recommended.map((configuration) => ({
    ...configuration,
    files: ['apps/**/*.ts'],
    languageOptions: {
      ...configuration.languageOptions,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      ...configuration.rules,
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      'no-console': 'off',
    },
  })),
];
