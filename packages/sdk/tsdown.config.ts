import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsdown';

/**
 * Bundles @atlas/sdk into a single publishable package. Internal `@atlas/*`
 * workspace packages are inlined (noExternal) since they are never published;
 * third-party runtime deps stay external and are declared in package.json.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  deps: { alwaysBundle: [/^@atlas\//] },
  alias: {
    '@': fileURLToPath(new URL('./src', import.meta.url)),
  },
});
