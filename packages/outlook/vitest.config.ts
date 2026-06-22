import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const root_dir = dirname(fileURLToPath(import.meta.url));
const types_src = resolve(root_dir, '../types/src');
const core_src = resolve(root_dir, '../core/src');
const m365_src = resolve(root_dir, '../m365-graph/src');
const outlook_src = resolve(root_dir, 'src');

function try_resolve_ts(base: string): string | null {
  if (existsSync(`${base}.ts`)) return `${base}.ts`;
  if (existsSync(`${base}.tsx`)) return `${base}.tsx`;
  if (existsSync(resolve(base, 'index.ts'))) return resolve(base, 'index.ts');
  return null;
}

/** Map `@/` to the correct package src based on the importing file (Vitest global `@` alias breaks workspace deps). */
function atlas_workspace_at_alias(): Plugin {
  return {
    name: 'atlas-workspace-at-alias',
    enforce: 'pre',
    resolveId(id, importer) {
      if (!id.startsWith('@/')) return null;
      if (!importer) return null;
      const sub = id.slice(2);
      const roots: Array<{ prefix: string; root: string }> = [
        { prefix: '/packages/outlook/', root: outlook_src },
        { prefix: '/packages/core/', root: core_src },
        { prefix: '/packages/m365-graph/', root: m365_src },
        { prefix: '/packages/types/', root: types_src },
      ];
      for (const { prefix, root } of roots) {
        if (importer.includes(prefix)) {
          return try_resolve_ts(resolve(root, sub));
        }
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [atlas_workspace_at_alias()],
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
      { find: /^@wisecom\/atlas-m365-graph\/(.+)$/, replacement: `${m365_src}/$1` },
      { find: '@wisecom/atlas-m365-graph', replacement: resolve(m365_src, 'index.ts') },
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
