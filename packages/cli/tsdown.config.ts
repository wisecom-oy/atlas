import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsdown';

/**
 * Bundles @wisecom/atlas-cli into a single publishable package. `cli.ts` is the
 * executable bin (shebang preserved); `index.ts` is the library entry.
 * Internal `@wisecom/atlas-*` workspace packages are inlined (noExternal) since they
 * are never published; third-party runtime deps stay external and are declared
 * in package.json.
 */
export default defineConfig({
  entry: ['src/cli.ts', 'src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  deps: { alwaysBundle: [/^@wisecom\/atlas-/] },
  alias: {
    '@': fileURLToPath(new URL('./src', import.meta.url)),
  },
});
