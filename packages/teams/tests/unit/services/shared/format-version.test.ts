import { describe, expect, it } from 'vitest';
import { UnreadableContentError, UnsupportedFormatVersionError } from '@wisecom/atlas-types';
import { assert_readable_format_version } from '@/services/shared/format-version';

const KEY = 'teams/manifests/t/teams-snap-1-aaaaaa.json';

describe('assert_readable_format_version', () => {
  it('accepts format_version 1', () => {
    expect(() => assert_readable_format_version(KEY, 1)).not.toThrow();
  });

  it('raises UnsupportedFormatVersionError for a newer format, not an unreadable one (N1)', () => {
    let caught: unknown;
    try {
      assert_readable_format_version(KEY, 2);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UnsupportedFormatVersionError);
    expect(caught).not.toBeInstanceOf(UnreadableContentError);
  });

  it.each([0, '1', undefined, null])(
    'raises UnreadableContentError for format_version %s',
    (format_version) => {
      expect(() => assert_readable_format_version(KEY, format_version)).toThrow(
        UnreadableContentError,
      );
    },
  );
});
