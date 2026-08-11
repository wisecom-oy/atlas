import { describe, it, expect } from 'vitest';
import type { SharePointDocumentLibrary } from '@wisecom/atlas-types';
import {
  describe_unresolved_destination,
  resolve_destination_library,
} from '@/services/sharepoint-restore-target';

function lib(drive_id: string, drive_name: string): SharePointDocumentLibrary {
  return { drive_id, drive_name };
}

const ONE_SOURCE_LIBRARY = true;
const MANY_SOURCE_LIBRARIES = false;

describe('resolve_destination_library', () => {
  it('matches the target library that carries the same name', () => {
    const target = [lib('t-assets', 'Site Assets'), lib('t-docs', 'Documents')];

    expect(resolve_destination_library('Documents', target, ONE_SOURCE_LIBRARY)).toEqual(
      lib('t-docs', 'Documents'),
    );
  });

  it('matches names case-insensitively', () => {
    const target = [lib('t-docs', 'Shared Documents'), lib('t-other', 'Archive')];

    expect(
      resolve_destination_library('shared documents', target, ONE_SOURCE_LIBRARY)?.drive_id,
    ).toBe('t-docs');
  });

  it('matches across Unicode forms and stray whitespace', () => {
    // "Työtiedostot" composed (NFC) in the manifest, decomposed (NFD) from Graph.
    const target = [lib('t-docs', 'Työtiedostot'.normalize('NFD')), lib('t-other', 'Archive')];

    expect(
      resolve_destination_library(' Työtiedostot '.normalize('NFC'), target, ONE_SOURCE_LIBRARY)
        ?.drive_id,
    ).toBe('t-docs');
  });

  it('uses the only library when the target site has exactly one', () => {
    // Real tenants localise the default library ("Tiedostot" vs "Documents"),
    // so a single-library target must resolve by position, not by name.
    expect(
      resolve_destination_library('Tiedostot', [lib('t-docs', 'Documents')], ONE_SOURCE_LIBRARY)
        ?.drive_id,
    ).toBe('t-docs');
  });

  it('resolves a single-library target even when the source name is unknown', () => {
    expect(
      resolve_destination_library(undefined, [lib('t-docs', 'Documents')], ONE_SOURCE_LIBRARY)
        ?.drive_id,
    ).toBe('t-docs');
  });

  it('refuses the lone-library fallback when the snapshot spans several libraries', () => {
    // Folding several source libraries into one destination merges their trees:
    // two files sharing a path would overwrite each other under --conflict replace.
    expect(
      resolve_destination_library('Tiedostot', [lib('t-docs', 'Documents')], MANY_SOURCE_LIBRARIES),
    ).toBeUndefined();
  });

  it('still matches by name when the snapshot spans several libraries', () => {
    const target = [lib('t-docs', 'Documents'), lib('t-archive', 'Archive')];

    expect(resolve_destination_library('Archive', target, MANY_SOURCE_LIBRARIES)?.drive_id).toBe(
      't-archive',
    );
  });

  it('refuses when two target libraries share the matched name', () => {
    const target = [lib('t-docs-a', 'Documents'), lib('t-docs-b', 'documents')];

    expect(resolve_destination_library('Documents', target, ONE_SOURCE_LIBRARY)).toBeUndefined();
  });

  it('refuses to guess between several non-matching libraries', () => {
    const target = [lib('t-docs', 'Documents'), lib('t-archive', 'Archive')];

    expect(resolve_destination_library('Tiedostot', target, ONE_SOURCE_LIBRARY)).toBeUndefined();
  });

  it('refuses to guess when the source library name was never recorded', () => {
    const target = [lib('t-docs', 'Documents'), lib('t-archive', 'Archive')];

    expect(resolve_destination_library(undefined, target, ONE_SOURCE_LIBRARY)).toBeUndefined();
  });

  it('never resolves against an empty target site', () => {
    expect(resolve_destination_library('Documents', [], ONE_SOURCE_LIBRARY)).toBeUndefined();
  });
});

describe('describe_unresolved_destination', () => {
  it('names the source library and the available candidates', () => {
    const message = describe_unresolved_destination(
      'Tiedostot',
      [lib('t-docs', 'Documents'), lib('t-archive', 'Archive')],
      ONE_SOURCE_LIBRARY,
    );

    expect(message).toContain('"Tiedostot"');
    expect(message).toContain('"Documents", "Archive"');
  });

  it('still reads sensibly when the source library name was never recorded', () => {
    const message = describe_unresolved_destination(
      undefined,
      [lib('t-docs', 'Documents')],
      ONE_SOURCE_LIBRARY,
    );

    expect(message).toContain('unnamed library');
    expect(message).not.toContain('undefined');
  });

  it('explains that a multi-library snapshot cannot be folded into one library', () => {
    const message = describe_unresolved_destination(
      'Policies',
      [lib('t-docs', 'Documents')],
      MANY_SOURCE_LIBRARIES,
    );

    expect(message).toContain('spans several libraries');
    expect(message).toContain('--file-filter');
  });
});
