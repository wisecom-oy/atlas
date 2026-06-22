import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const root_dir = dirname(fileURLToPath(import.meta.url));
const core_src = resolve(root_dir, '../core/src');
const s3_src = resolve(root_dir, 'src');

function resolve_ts_under(base: string, subpath: string): string | undefined {
  const direct = resolve(base, subpath);
  if (existsSync(direct) && direct.endsWith('.ts')) return direct;
  const with_ts = resolve(base, `${subpath}.ts`);
  if (existsSync(with_ts)) return with_ts;
  const index_ts = resolve(base, subpath, 'index.ts');
  if (existsSync(index_ts)) return index_ts;
  return undefined;
}

/**
 * `@wisecom/atlas-s3` and `@wisecom/atlas-core` both use `@/`; a single Vitest `alias: { '@': ... }` would
 * mis-resolve core's `@/` as paths under this package.
 */
function resolve_atlas_at_path_aliases(): Plugin {
  return {
    name: 'atlas-split-at-alias',
    enforce: 'pre',
    resolveId(id, importer) {
      if (!id.startsWith('@/')) return null;
      if (!importer) return null;
      const imp_path = importer.startsWith('file:') ? fileURLToPath(importer) : importer;
      const norm = imp_path.replace(/\\/g, '/');
      const sub = id.slice(2);
      if (norm.includes('/packages/core/')) {
        return resolve_ts_under(core_src, sub);
      }
      if (norm.includes('/packages/s3/')) {
        return resolve_ts_under(s3_src, sub);
      }
      return null;
    },
  };
}

const types_src = resolve(root_dir, '../types/src');

export default defineConfig({
  plugins: [resolve_atlas_at_path_aliases()],
  resolve: {
    alias: [
      {
        find: '@wisecom/atlas-types/testing/stub-tenant-create-cipher',
        replacement: resolve(types_src, 'testing/stub-tenant-create-cipher.ts'),
      },
      { find: /^@wisecom\/atlas-types\/(.+)$/, replacement: `${types_src}/$1` },
      { find: '@wisecom/atlas-types', replacement: resolve(types_src, 'index.ts') },
      { find: /^@wisecom\/atlas-core\/(.+)$/, replacement: `${core_src}/$1` },
      { find: '@wisecom/atlas-core', replacement: resolve(core_src, 'index.ts') },
    ],
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
