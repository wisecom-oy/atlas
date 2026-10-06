import { defineConfig } from 'vitest/config';

/**
 * Runs every package's own Vitest config as a project, so `pnpm run test:coverage` measures each
 * source file against every test that reaches it.
 *
 * Shared code is mostly exercised through other packages: `drive` through `onedrive` and
 * `sharepoint`, `core` and `types` through everyone. A per-package run only counts that package's
 * own tests and reported `drive` at 26% when it is above 90% (issue #445).
 */
export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.{ts,tsx}'],
      exclude: ['packages/*/src/**/index.ts', 'packages/types/src/testing/**'],
      reporter: ['text-summary', 'json-summary', 'lcov', 'html'],
      reportsDirectory: 'coverage',
    },
  },
});
