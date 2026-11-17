// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const tsFiles = ['packages/**/*.ts', 'apps/desktop/**/*.ts'];

export default tseslint.config(
  // Base recommended rules
  eslint.configs.recommended,

  // Scoped TypeScript type-checked rules for TS packages/apps
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: config.files ?? tsFiles,
  })),
  prettierConfig,

  {
    files: tsFiles,
    languageOptions: {
      parserOptions: {
        project: [
          './packages/core/tsconfig.eslint.json',
          './packages/application/tsconfig.eslint.json',
          './packages/infrastructure/tsconfig.eslint.json',
          './packages/shared/tsconfig.json',
          './packages/application/tsconfig.json',
          './apps/desktop/tsconfig.eslint.json',
        ],
        tsconfigRootDir: __dirname,
      },
    },
  },

  // ─── FINANCIAL SAFETY RULES (TypeScript) ──────────────────────────────────
  {
    files: tsFiles,
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message: 'Use Money.fromDecimal() for monetary values, never parseFloat().',
        },
        {
          name: 'parseInt',
          message: 'Use BigInt() for monetary minor-unit values, never parseInt().',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='Number']",
          message: 'Do not coerce to Number. Use BigInt arithmetic for monetary values.',
        },
        {
          selector:
            "CallExpression[callee.object.name='Math'][callee.property.name=/^(round|floor|ceil|trunc)$/]",
          message:
            "Avoid Math rounding functions in financial code. Use BigInt division and the Money.multiply() Banker's Rounding instead.",
        },
      ],

      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/require-await': 'error',
    },
  },

  // ─── TEST FILES (TypeScript) ──────────────────────────────────────────────
  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-restricted-syntax': 'off',
      'no-restricted-globals': 'off',
    },
  },

  // ─── WEB SERVER, BUILD & TESTS (Node ESM) ─────────────────────────────────
  {
    files: ['apps/web/server.mjs', 'apps/web/build.mjs', 'apps/web/tests/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        AbortController: 'readonly',
        Blob: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        clearInterval: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        crypto: 'readonly',
        fetch: 'readonly',
        FormData: 'readonly',
        Headers: 'readonly',
        Intl: 'readonly',
        process: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly',
        structuredClone: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
      },
    },
    rules: {
      eqeqeq: ['error', 'smart'],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  // ─── WEB CLIENT UI (Browser ESM / Script) ─────────────────────────────────
  {
    files: ['apps/web/public/**/*.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: {
        AbortController: 'readonly',
        alert: 'readonly',
        atob: 'readonly',
        Blob: 'readonly',
        btoa: 'readonly',
        clearInterval: 'readonly',
        clearTimeout: 'readonly',
        confirm: 'readonly',
        console: 'readonly',
        crypto: 'readonly',
        CustomEvent: 'readonly',
        document: 'readonly',
        Element: 'readonly',
        Event: 'readonly',
        fetch: 'readonly',
        File: 'readonly',
        FileReader: 'readonly',
        FormData: 'readonly',
        Headers: 'readonly',
        history: 'readonly',
        HTMLElement: 'readonly',
        Image: 'readonly',
        Intl: 'readonly',
        KeyboardEvent: 'readonly',
        localStorage: 'readonly',
        location: 'readonly',
        MouseEvent: 'readonly',
        navigator: 'readonly',
        Request: 'readonly',
        requestAnimationFrame: 'readonly',
        Response: 'readonly',
        sessionStorage: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        window: 'readonly',
      },
    },
    rules: {
      eqeqeq: ['error', 'smart'],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  // ─── IGNORE PATTERNS ───────────────────────────────────────────────────────
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/release/**',
      '**/node_modules/**',
      '**/*.d.ts',
      'eslint.config.mjs',
      'scripts/**',
    ],
  },
);
