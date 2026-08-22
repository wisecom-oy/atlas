import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root_dir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(root_dir, 'src'),
      // Directory alias, so any helper under types/testing resolves without a
      // per-file entry going stale (issue #155).
      '@wisecom/atlas-types/testing': resolve(root_dir, '../types/src/testing'),
      '@wisecom/atlas-types': resolve(root_dir, '../types/src/index.ts'),
    },
  },
  test: {
    globals: true,
    root: '.',
    include: ['tests/**/*.test.ts'],
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts'],
    },
  },
});
