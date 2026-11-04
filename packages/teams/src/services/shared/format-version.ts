import { UnreadableContentError } from '@wisecom/atlas-types';

/** The Teams manifest and cursor layout this Atlas reads. A missing version is legacy and reads the same. */
export const TEAMS_FORMAT_VERSION = 1;

/** Rejects state written by a different layout version, so an older Atlas never misreads newer fields. */
export function assert_readable_format_version(
  key: string,
  format_version: number | undefined,
): void {
  if (format_version === undefined || format_version === TEAMS_FORMAT_VERSION) return;
  throw new UnreadableContentError(
    `The Teams state at ${key} uses format_version ${format_version}; this Atlas reads format_version ${TEAMS_FORMAT_VERSION}. Upgrade Atlas to read it.`,
  );
}
