import {
  TEAMS_FORMAT_VERSION,
  UnreadableContentError,
  UnsupportedFormatVersionError,
} from '@wisecom/atlas-types';

/**
 * Accepts only the Teams layout this build writes. A higher version is intact content from a newer
 * Atlas and raises `UnsupportedFormatVersionError`, so the fix is an upgrade; any other version is
 * damage and raises `UnreadableContentError`.
 */
export function assert_readable_format_version(key: string, format_version: unknown): void {
  if (format_version === TEAMS_FORMAT_VERSION) return;
  if (typeof format_version === 'number' && format_version > TEAMS_FORMAT_VERSION) {
    throw new UnsupportedFormatVersionError(
      `The Teams object at ${key} uses format_version ${format_version}; this Atlas reads format_version ${TEAMS_FORMAT_VERSION}. Upgrade Atlas to read it.`,
    );
  }
  throw new UnreadableContentError(
    `The Teams object at ${key} has format_version ${String(format_version)}; this Atlas reads format_version ${TEAMS_FORMAT_VERSION}.`,
  );
}
