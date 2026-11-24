import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsdown';

/**
 * Bundles @wisecom/atlas-sdk into a single publishable package. Internal `@wisecom/atlas-*`
 * workspace packages are inlined (noExternal) since they are never published;
 * third-party runtime deps stay external and are declared in package.json.
 */
export default defineConfig({
  // `contract` is a separate entry so a browser or Worker can import it without the Node SDK.
  entry: { index: 'src/index.ts', contract: 'src/contract.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  deps: { alwaysBundle: [/^@wisecom\/atlas-/] },
  alias: {
    '@': fileURLToPath(new URL('./src', import.meta.url)),
  },
});
