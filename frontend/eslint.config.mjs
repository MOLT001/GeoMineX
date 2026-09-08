import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';
import tseslint from 'typescript-eslint';

/**
 * `eslint-config-next` 16 exports native flat-config arrays, so there is no
 * FlatCompat shim and no `@eslint/eslintrc` dependency here.
 *
 * Note that Next 16 removed `next lint` and no longer runs ESLint during
 * `next build` — CI's `npm run lint` step is the only gate.
 */
export default tseslint.config(
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts', 'public/**'] },

  ...nextCoreWebVitals,
  ...nextTypescript,
  ...tseslint.configs.recommendedTypeChecked,

  {
    /**
     * Pin the React version instead of leaving it to auto-detection.
     *
     * Not cosmetic: the `eslint-plugin-react` bundled inside eslint-config-next
     * detects the version via `context.getFilename()`, which ESLint 10 removed,
     * so auto-detection throws `contextOrFilename.getFilename is not a function`
     * and takes every React rule down with it. Supplying the version explicitly
     * skips detection entirely.
     *
     * Keep this in step with the `react` version in package.json. The
     * alternative was downgrading to ESLint 9, which would have split the
     * repo's toolchain — the backend is on ESLint 10.
     */
    settings: { react: { version: '19.2' } },
  },

  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      /**
       * PRD §7.1: `src/lib/env.ts` is the single source of truth for
       * configuration and nothing else may read process.env. A stray
       * `process.env.NEXT_PUBLIC_*` elsewhere bypasses Zod validation, and
       * because Next does a literal text substitution it silently yields
       * `undefined` in the browser rather than failing.
       */
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Read configuration from src/lib/env.ts (PRD §7.1) — the only module permitted to touch process.env.',
        },
      ],

      /**
       * PRD §9.13: credentials live in memory only. Persisting the query cache
       * writes authenticated server state to browser storage, which is a direct
       * violation — and it is the plausible-looking thing someone reaches for
       * while chasing a perceived performance win.
       */
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@tanstack/react-query-persist-client',
              message:
                'Persisting the query cache writes authenticated data to browser storage (PRD §9.13).',
            },
          ],
        },
      ],

      /** Tokens and document-derived text must never reach the console. */
      'no-console': ['warn', { allow: ['warn', 'error'] }],

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // The configuration modules are the one place process.env is legitimate.
  {
    files: ['src/lib/env.ts', 'next.config.ts', 'proxy.ts', 'src/lib/csp.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },

  {
    // Next's config contract declares `rewrites()` and `headers()` as async and
    // resolves them at build time. They have nothing to await, so require-await
    // fires on a signature we do not control.
    files: ['next.config.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },

  // Config files are not part of the typed project graph.
  {
    files: ['*.mjs', '*.config.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
);
