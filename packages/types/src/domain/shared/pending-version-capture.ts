import type { NotFoundStreak } from '@/domain/shared/failed-item';

/**
 * A file whose historical versions a drive backup has not finished capturing.
 *
 * The file's content can be in storage while its versions are not: the run stored the content,
 * then stopped before the version capture finished. The next run finds the content already
 * stored, and without this record it would read that as "nothing changed" and skip the versions
 * for good (issue #858). The record is kept until a capture of the file finishes with no failed
 * version.
 */
export interface PendingVersionCapture {
  /**
   * Versions the run listed whose content read answered "not found", by version id. One such
   * answer is not proof the version is gone, so it is accepted as expired only once the streak
   * confirms it (issue #855).
   */
  readonly not_found?: Readonly<Record<string, NotFoundStreak>>;
}
