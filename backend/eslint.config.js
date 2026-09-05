import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // A dedicated project so tests and root config files are type-aware
        // too; tsconfig.json itself is build scope and excludes them.
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off', // Used deliberately after requireAuth.
      'no-console': 'error', // Use the logger; console output is unstructured and unredacted.
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Supertest response bodies are `any` by design, so the unsafe-* family
    // fires on ordinary assertions. Relaxed for tests only — src/ keeps them.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  {
    /**
     * PRD §9.5: no model-driven code path may reach a privileged action.
     *
     * The queries module and the AI service write only to `queries` and the
     * audit log. Making that a BUILD FAILURE rather than a review convention
     * matters because the rule is invisible at the call site -- an ordinary
     * looking `import { publishReport }` is exactly what an injected
     * instruction would need, and nothing else in the file would look wrong.
     *
     * MODELS stay importable: a scoped read of `report.model.js` is how a
     * `linkedReportId` is validated. It is the mutating SERVICES that are out
     * of reach.
     */
    files: ['src/modules/queries/**/*.ts', 'src/services/ai/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/modules/reports/report.service*',
                '**/modules/users/user.service*',
                '**/modules/documents/document.service*',
                '**/modules/auth/**',
                '**/services/storage/**',
              ],
              message:
                'PRD §9.5: no model-driven code path may reach a privileged action. The queries module writes only to `queries` and the audit log.',
            },
          ],
        },
      ],
    },
  },
  {
    // Standalone maintenance scripts run with `node <file>` by an operator.
    // Their console output IS the interface -- there is no request to attach a
    // structured log line to -- and they are plain Node, so the browser-shaped
    // default globals do not apply.
    files: ['*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', setTimeout: 'readonly' },
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
);
