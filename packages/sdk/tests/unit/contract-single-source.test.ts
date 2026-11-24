import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const PACKAGES_DIR = resolve(import.meta.dirname, '../../..');

/** Every TypeScript source file under `packages/<name>/src`, as [repo-relative path, text]. */
function read_package_sources(): [string, string][] {
  const sources: [string, string][] = [];
  for (const package_name of readdirSync(PACKAGES_DIR)) {
    const src_dir = join(PACKAGES_DIR, package_name, 'src');
    let entries: string[];
    try {
      entries = readdirSync(src_dir, { recursive: true, encoding: 'utf8' });
    } catch {
      continue;
    }
    for (const entry of entries.filter((name) => name.endsWith('.ts'))) {
      const path = join(src_dir, entry);
      sources.push([relative(PACKAGES_DIR, path), readFileSync(path, 'utf8')]);
    }
  }
  return sources;
}

/** Files whose text matches the pattern. */
function files_matching(sources: [string, string][], pattern: RegExp): string[] {
  return sources.filter(([, text]) => pattern.test(text)).map(([path]) => path);
}

const SOURCES = read_package_sources();

/**
 * The contract subpath publishes the binding Atlas enforces with (issue #824). An inline copy of
 * one of these rules would let the published and the enforced value drift, so each rule may be
 * stated in exactly one module.
 */
describe('contract rules have a single source', () => {
  it('reads the source tree', () => {
    expect(SOURCES.length).toBeGreaterThan(100);
  });

  it('declares the passphrase floor once', () => {
    expect(files_matching(SOURCES, /\bMIN_PASSPHRASE_BYTES\s*=/)).toEqual([
      'core/src/services/keys/passphrase-floor.ts',
    ]);
  });

  it('counts passphrase bytes only through passphrase_byte_length', () => {
    expect(files_matching(SOURCES, /byteLength\([^)]*passphrase/i)).toEqual([]);
    expect(files_matching(SOURCES, /passphrase[^\n;]*[<>]=?\s*14\b/i)).toEqual([]);
  });

  it('declares the canonical site id rule once', () => {
    expect(files_matching(SOURCES, /function canonical_site_id\b/)).toEqual([
      'types/src/domain/sharepoint/site-id.ts',
    ]);
  });

  it('declares the owner and Teams id rules once', () => {
    expect(files_matching(SOURCES, /function (normalize_owner_id|parse_team_id)\b/)).toEqual([
      'core/src/services/shared/identifier-normalization.ts',
    ]);
    expect(files_matching(SOURCES, /\bGUID_RE\s*=/)).toEqual([
      'core/src/services/shared/identifier-normalization.ts',
    ]);
  });

  it('spells the Graph pool names only in GRAPH_SERVICE_POOLS', () => {
    expect(files_matching(SOURCES, /'outlook'\s*\|\s*'sharepoint_onedrive'/)).toEqual([]);
  });
});
