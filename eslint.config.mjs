// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  // Base recommended rules
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettierConfig,

  // Global parser settings — use per-package tsconfig.eslint.json for type-aware linting
  {
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

  // ─── FINANCIAL SAFETY RULES ───────────────────────────────────────────────
  {
    files: ['packages/**/*.ts', 'apps/**/*.ts'],
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

  // ─── TEST FILES ────────────────────────────────────────────────────────────
  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-restricted-syntax': 'off',
      'no-restricted-globals': 'off',
    },
  },

  // ─── IGNORE PATTERNS ───────────────────────────────────────────────────────
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.js',
      '**/*.d.ts',
      'eslint.config.mjs',
    ],
  },
);
