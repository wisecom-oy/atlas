import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root_dir = dirname(fileURLToPath(import.meta.url));
const types_src = resolve(root_dir, '../types/src');
const core_src = resolve(root_dir, '../core/src');
const m365_src = resolve(root_dir, '../m365-graph/src');
const s3_src = resolve(root_dir, '../s3/src');
const outlook_src = resolve(root_dir, '../outlook/src');
const onedrive_src = resolve(root_dir, '../onedrive/src');
const sharepoint_src = resolve(root_dir, '../sharepoint/src');

export default defineConfig({
  resolve: {
    alias: [
      { find: '@', replacement: resolve(root_dir, 'src') },
      { find: /^@wisecom\/atlas-types\/(.+)$/, replacement: `${types_src}/$1` },
      { find: '@wisecom/atlas-types', replacement: resolve(types_src, 'index.ts') },
      { find: /^@wisecom\/atlas-core\/(.+)$/, replacement: `${core_src}/$1` },
      { find: '@wisecom/atlas-core', replacement: resolve(core_src, 'index.ts') },
      { find: /^@wisecom\/atlas-m365-graph\/(.+)$/, replacement: `${m365_src}/$1` },
      { find: '@wisecom/atlas-m365-graph', replacement: resolve(m365_src, 'index.ts') },
      { find: /^@wisecom\/atlas-s3\/(.+)$/, replacement: `${s3_src}/$1` },
      { find: '@wisecom/atlas-s3', replacement: resolve(s3_src, 'index.ts') },
      { find: /^@wisecom\/atlas-outlook\/(.+)$/, replacement: `${outlook_src}/$1` },
      { find: '@wisecom/atlas-outlook', replacement: resolve(outlook_src, 'index.ts') },
      { find: /^@wisecom\/atlas-onedrive\/(.+)$/, replacement: `${onedrive_src}/$1` },
      { find: '@wisecom/atlas-onedrive', replacement: resolve(onedrive_src, 'index.ts') },
      { find: /^@wisecom\/atlas-sharepoint\/(.+)$/, replacement: `${sharepoint_src}/$1` },
      { find: '@wisecom/atlas-sharepoint', replacement: resolve(sharepoint_src, 'index.ts') },
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
