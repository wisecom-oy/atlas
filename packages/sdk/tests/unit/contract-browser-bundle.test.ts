import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'tsdown';

const SDK_ROOT = resolve(import.meta.dirname, '../..');
/** Any static or dynamic import, or a CommonJS require, left in the bundled output. */
const SURVIVING_IMPORT = /^\s*import\b|^\s*export\s[^;]*\bfrom\s|\bimport\s*\(|\brequire\s*\(/m;
/** Node globals a browser or a Worker does not provide. */
const NODE_GLOBAL = /\bnode:|\bBuffer\b|\bprocess\./;
const COMMENT = /\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm;

let out_dir: string;
let bundled: string;

beforeAll(async () => {
  out_dir = await mkdtemp(join(tmpdir(), 'atlas-contract-browser-'));
  await build({
    config: false,
    cwd: SDK_ROOT,
    entry: { contract: 'src/contract.ts' },
    format: ['esm'],
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: false,
    outDir: out_dir,
    logLevel: 'silent',
    // Same rule as the published build: workspace packages are inlined, everything else would
    // stay an import, which is exactly what this test refuses.
    deps: { alwaysBundle: [/^@wisecom\/atlas-/] },
  });
  // The extension follows the platform (`.js` for a browser), so take every JavaScript file.
  const files = (await readdir(out_dir)).filter((name) => /\.[cm]?js$/.test(name));
  expect(files.length).toBeGreaterThan(0);
  const sources = await Promise.all(files.map((name) => readFile(join(out_dir, name), 'utf8')));
  bundled = sources.join('\n');
}, 60_000);

afterAll(async () => {
  await rm(out_dir, { recursive: true, force: true });
});

describe('@wisecom/atlas-sdk/contract bundled for a browser', () => {
  it('needs no Node built-in and no third-party package', () => {
    expect(bundled).not.toMatch(SURVIVING_IMPORT);
    expect(bundled.replace(COMMENT, '')).not.toMatch(NODE_GLOBAL);
  });

  it('still carries the rules it publishes', () => {
    expect(bundled).toMatch(/MIN_PASSPHRASE_BYTES\s*=\s*14/);
    expect(bundled).toContain('TextEncoder');
    expect(bundled).toContain('atlas-${');
  });
});
