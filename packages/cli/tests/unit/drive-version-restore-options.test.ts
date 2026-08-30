import { describe, expect, it } from 'vitest';
import { build_version_restore_options } from '@/commands/drive-version-restore.handlers';

describe('build_version_restore_options', () => {
  it('maps a single-version restore', () => {
    expect(
      build_version_restore_options({ file: '/Documents/Report.docx', version: '3.0' }),
    ).toEqual({
      file_ref: '/Documents/Report.docx',
      version_id: '3.0',
      placement: 'copy',
    });
  });

  it('defaults to the copy placement', () => {
    const options = build_version_restore_options({ before: '2026-03-10T00:00:00Z' });

    // The destructive-looking option has to be asked for by name.
    expect(options.placement).toBe('copy');
  });

  it('selects in-place only when the flag is present', () => {
    const options = build_version_restore_options({
      before: '2026-03-10T00:00:00Z',
      inPlace: true,
    });

    expect(options.placement).toBe('in-place');
  });

  it('parses the cutoff into a Date', () => {
    const options = build_version_restore_options({ before: '2026-03-10T00:00:00Z' });

    expect(options.before?.toISOString()).toBe('2026-03-10T00:00:00.000Z');
  });

  it('rejects a cutoff that is not a date', () => {
    expect(() => build_version_restore_options({ before: 'last tuesday' })).toThrow(
      /not a valid date/,
    );
  });

  it('rejects --version without --file', () => {
    // Version ids are per file, so '3.0' alone names nothing.
    expect(() => build_version_restore_options({ version: '3.0' })).toThrow(
      /--version needs --file/,
    );
  });

  it('rejects a run with neither a file nor a cutoff', () => {
    expect(() => build_version_restore_options({})).toThrow(/--file with --version, or --before/);
  });

  it('rejects --path combined with --file', () => {
    // A folder scope and a single file are two different requests, and
    // silently ignoring one of them would restore the wrong set.
    expect(() =>
      build_version_restore_options({ file: '/a.docx', version: '1.0', path: '/Documents' }),
    ).toThrow(/cannot be combined with --file/);
  });

  it('omits absent flags rather than passing undefined through', () => {
    const options = build_version_restore_options({ before: '2026-03-10T00:00:00Z' });

    // exactOptionalPropertyTypes is on: an explicit undefined is not the same
    // as an absent key for the service's option checks.
    expect('file_ref' in options).toBe(false);
    expect('version_id' in options).toBe(false);
    expect('path_prefix' in options).toBe(false);
  });
});
