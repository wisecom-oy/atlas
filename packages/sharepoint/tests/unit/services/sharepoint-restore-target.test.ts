import { describe, it, expect } from 'vitest';
import type { SharePointDocumentLibrary } from '@wisecom/atlas-types';
import {
  describe_unresolved_destination,
  resolve_destination_library,
} from '@/services/sharepoint-restore-target';

function lib(drive_id: string, drive_name: string): SharePointDocumentLibrary {
  return { drive_id, drive_name };
}

describe('resolve_destination_library', () => {
  it('matches the target library that carries the same name', () => {
    const target = [lib('t-assets', 'Site Assets'), lib('t-docs', 'Documents')];

    expect(resolve_destination_library('Documents', target)).toEqual(lib('t-docs', 'Documents'));
  });

  it('matches names case-insensitively', () => {
    const target = [lib('t-docs', 'Shared Documents'), lib('t-other', 'Archive')];

    expect(resolve_destination_library('shared documents', target)?.drive_id).toBe('t-docs');
  });

  it('uses the only library when the target site has exactly one', () => {
    // Real tenants localise the default library ("Tiedostot" vs "Documents"),
    // so a single-library target must resolve by position, not by name.
    expect(resolve_destination_library('Tiedostot', [lib('t-docs', 'Documents')])?.drive_id).toBe(
      't-docs',
    );
  });

  it('resolves a single-library target even when the source name is unknown', () => {
    expect(resolve_destination_library(undefined, [lib('t-docs', 'Documents')])?.drive_id).toBe(
      't-docs',
    );
  });

  it('refuses to guess between several non-matching libraries', () => {
    const target = [lib('t-docs', 'Documents'), lib('t-archive', 'Archive')];

    expect(resolve_destination_library('Tiedostot', target)).toBeUndefined();
  });

  it('refuses to guess when the source library name was never recorded', () => {
    const target = [lib('t-docs', 'Documents'), lib('t-archive', 'Archive')];

    expect(resolve_destination_library(undefined, target)).toBeUndefined();
  });

  it('never resolves against an empty target site', () => {
    expect(resolve_destination_library('Documents', [])).toBeUndefined();
  });
});

describe('describe_unresolved_destination', () => {
  it('names the source library and the available candidates', () => {
    const message = describe_unresolved_destination('report.docx', 'Tiedostot', [
      lib('t-docs', 'Documents'),
      lib('t-archive', 'Archive'),
    ]);

    expect(message).toContain('report.docx');
    expect(message).toContain('"Tiedostot"');
    expect(message).toContain('"Documents", "Archive"');
  });
});
