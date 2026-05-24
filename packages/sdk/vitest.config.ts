import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root_dir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(root_dir, 'src'),
      '@atlas/types': resolve(root_dir, '../types/src/index.ts'),
      '@atlas/core': resolve(root_dir, '../core/src/index.ts'),
      '@atlas/m365-graph': resolve(root_dir, '../m365-graph/src/index.ts'),
      '@atlas/s3': resolve(root_dir, '../s3/src/index.ts'),
      '@atlas/outlook': resolve(root_dir, '../outlook/src/index.ts'),
      '@atlas/onedrive': resolve(root_dir, '../onedrive/src/index.ts'),
      '@atlas/sharepoint': resolve(root_dir, '../sharepoint/src/index.ts'),
    },
  },
  test: {
    globals: true,
    root: '.',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts'],
    },
  },
});
