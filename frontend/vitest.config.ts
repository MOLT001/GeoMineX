import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    /**
     * `src/lib/env.ts` validates the environment at module scope and THROWS on
     * a miss — deliberately, so a misconfigured deployment fails the build
     * rather than the user's first page load (§7.1). Vitest does not run Next's
     * env loading, so any test that transitively imports the API client would
     * otherwise die on import with a message about `.env.example` rather than
     * on its own assertions.
     *
     * These are fixed, obviously-fake values. They are never dialled: no test
     * in this suite performs real I/O, and `NEXT_PUBLIC_` carries nothing
     * secret by construction — the frontend's entire environment contract is
     * two public URLs.
     */
    env: {
      NEXT_PUBLIC_API_BASE_URL: 'http://localhost:5001',
      NEXT_PUBLIC_SITE_URL: 'http://localhost:3000',
    },
  },
});
