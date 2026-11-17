import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  create_entry_program,
  find_workspace_files_read_from_dist,
  find_unexported_signature_types,
} from './public-signature-walk';

/**
 * Every type named in a public SDK signature must be importable from the entry point (issue #784).
 * A consumer otherwise reaches it only through `ReturnType`.
 */
const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(TESTS_DIR, '../..');
const SDK_CONFIG = join(SDK_DIR, 'tsconfig.json');
const FIXTURE_ENTRY = join(TESTS_DIR, 'public-surface-entry.fixtures.ts');

describe('public SDK type exports', () => {
  it('exports every Atlas type named in a public signature', () => {
    const entry = join(SDK_DIR, 'src/index.ts');
    const program = create_entry_program(entry, SDK_CONFIG);

    // A declaration read from `dist` could predate its source, and the walk would check an old
    // signature. The program must see source only.
    expect(find_workspace_files_read_from_dist(program)).toEqual([]);
    expect(find_unexported_signature_types(program, entry)).toEqual([]);
  }, 60_000);

  it('reports a type named only by an exported method or callback alias', () => {
    const program = create_entry_program(FIXTURE_ENTRY, SDK_CONFIG);

    // `HiddenEvent` is reachable only through the `EventCallback` alias's parameter, the path an
    // interface-only walk misses; `HiddenOptions` only through `FixtureApi.run`.
    expect(find_unexported_signature_types(program, FIXTURE_ENTRY)).toEqual([
      'HiddenEvent',
      'HiddenOptions',
    ]);
  }, 60_000);
});
