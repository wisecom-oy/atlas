import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root_dir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(root_dir, 'src'),
      '@atlas/types/testing/stub-tenant-create-cipher': resolve(
        root_dir,
        '../types/src/testing/stub-tenant-create-cipher.ts',
      ),
      '@atlas/types': resolve(root_dir, '../types/src/index.ts'),
    },
  },
  test: {
    globals: true,
    root: '.',
    include: ['tests/**/*.test.ts'],
    testTimeout: 15000,
    exclude: [
      'tests/unit/services/delta-safeguard.test.ts',
      'tests/unit/services/mailbox-sync-object-lock.test.ts',
      'tests/unit/services/attachment-progress-callback.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts'],
    },
  },
});
