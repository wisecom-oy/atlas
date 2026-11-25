import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'tsdown';
import ts from 'typescript';

const SDK_ROOT = resolve(import.meta.dirname, '../..');
const DOCS_ROOT = resolve(SDK_ROOT, '../../docs');
/** Pages whose `ts` blocks import the contract entry; each such block must typecheck. */
const DOC_PAGES = ['reference/contract-examples.md', 'reference/sdk.md'];
const CONTRACT_SPECIFIER = '@wisecom/atlas-sdk/contract';
const TS_BLOCK = /```ts\n([\s\S]*?)```/g;
/** A full program check with `lib.dom` takes several seconds under CI coverage. */
const TYPECHECK_TIMEOUT_MS = 30_000;

let out_dir: string;
let contract_declarations: string;

/** Every `ts` block on a page that imports the contract entry, labelled with its page. */
async function read_contract_snippets(): Promise<{ label: string; code: string }[]> {
  const snippets: { label: string; code: string }[] = [];
  for (const page of DOC_PAGES) {
    const markdown = await readFile(join(DOCS_ROOT, page), 'utf8');
    let index = 0;
    for (const match of markdown.matchAll(TS_BLOCK)) {
      const code = match[1] ?? '';
      index += 1;
      if (!code.includes(`'${CONTRACT_SPECIFIER}'`)) continue;
      snippets.push({ label: `${page}#${index}`, code });
    }
  }
  return snippets;
}

/**
 * Typechecks the snippets as a browser or Worker project would see them: DOM and ES2022 only,
 * no `@types/node`, and the contract resolved to its published declarations.
 */
function typecheck(files: string[]): string[] {
  const program = ts.createProgram(files, {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    types: [],
    paths: { [CONTRACT_SPECIFIER]: [contract_declarations] },
  });
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

beforeAll(async () => {
  out_dir = await mkdtemp(join(tmpdir(), 'atlas-contract-docs-'));
  // Same entry and bundling rule as the published build, so the declarations are the ones a
  // consumer installs.
  await build({
    config: false,
    cwd: SDK_ROOT,
    entry: { contract: 'src/contract.ts' },
    format: ['esm'],
    platform: 'neutral',
    dts: true,
    sourcemap: false,
    outDir: join(out_dir, 'dist'),
    logLevel: 'silent',
    deps: { alwaysBundle: [/^@wisecom\/atlas-/] },
  });
  const emitted = await readdir(join(out_dir, 'dist'));
  const entry = emitted.find((name) => /^contract\.d\.[cm]?ts$/.test(name));
  expect(entry).toBeDefined();
  contract_declarations = join(out_dir, 'dist', entry ?? '');
}, 60_000);

afterAll(async () => {
  await rm(out_dir, { recursive: true, force: true });
});

describe('contract snippets in the docs', { timeout: TYPECHECK_TIMEOUT_MS }, () => {
  it('typecheck against the published declarations without Node types', async () => {
    const snippets = await read_contract_snippets();
    expect(snippets.length).toBeGreaterThanOrEqual(5);
    const files: string[] = [];
    for (const [index, snippet] of snippets.entries()) {
      const file = join(out_dir, `snippet-${index}.ts`);
      await writeFile(file, `// ${snippet.label}\n${snippet.code}`);
      files.push(file);
    }
    expect(typecheck(files)).toEqual([]);
  });

  it('fail the check when a snippet uses a name the contract does not export', async () => {
    const file = join(out_dir, 'drifted.ts');
    await writeFile(
      file,
      `import { tenantBucket } from '${CONTRACT_SPECIFIER}';\ntenantBucket('x');\n`,
    );
    expect(typecheck([file]).join('\n')).toMatch(/tenantBucket/);
  });
});
