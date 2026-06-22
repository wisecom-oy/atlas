import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root_dir = dirname(fileURLToPath(import.meta.url));
const types_src = resolve(root_dir, '../types/src');
const core_src = resolve(root_dir, '../core/src');

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@wisecom\/atlas-types\/(.+)$/, replacement: `${types_src}/$1` },
      { find: '@wisecom/atlas-types', replacement: resolve(types_src, 'index.ts') },
      { find: /^@wisecom\/atlas-core\/(.+)$/, replacement: `${core_src}/$1` },
      { find: '@wisecom/atlas-core', replacement: resolve(core_src, 'index.ts') },
      { find: '@', replacement: resolve(root_dir, 'src') },
    ],
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
