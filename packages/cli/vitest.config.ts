import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const root_dir = dirname(fileURLToPath(import.meta.url));

/** Resolves `@/*` in workspace package sources and CLI tests during Vitest. */
function resolve_workspace_at_alias(vitest_package_root: string): Plugin {
  return {
    name: 'atlas-vitest-workspace-at-alias',
    enforce: 'pre',
    resolveId(id, importer) {
      if (!id.startsWith('@/') || !importer) return null;

      const from_file = importer.replace(/^file:\/\//, '');
      const subpath = id.slice(2);

      let pkg_src: string | null = null;
      if (/\/packages\/cli\//.test(from_file)) {
        pkg_src = resolve(vitest_package_root, 'src');
      } else {
        const pkg_match = from_file.match(/\/packages\/([^/]+)\/src\//);
        if (pkg_match) {
          pkg_src = resolve(vitest_package_root, '..', pkg_match[1], 'src');
        }
      }

      if (!pkg_src) return null;
      const base = resolve(pkg_src, subpath);
      const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`];
      for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate;
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [resolve_workspace_at_alias(root_dir)],
  resolve: {
    alias: [
      {
        find: /^@wisecom\/atlas-core\/(.+)$/,
        replacement: resolve(root_dir, '../core/src/$1'),
      },
      { find: '@wisecom/atlas-types/ports', replacement: resolve(root_dir, '../types/src/ports') },
      { find: '@wisecom/atlas-types', replacement: resolve(root_dir, '../types/src/index.ts') },
      {
        find: '@wisecom/atlas-m365-graph',
        replacement: resolve(root_dir, '../m365-graph/src/index.ts'),
      },
      { find: '@wisecom/atlas-s3', replacement: resolve(root_dir, '../s3/src/index.ts') },
      { find: '@wisecom/atlas-outlook', replacement: resolve(root_dir, '../outlook/src/index.ts') },
      { find: '@wisecom/atlas-core', replacement: resolve(root_dir, '../core/src/index.ts') },
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
      exclude: ['src/**/index.ts', 'src/cli.ts'],
    },
  },
});
