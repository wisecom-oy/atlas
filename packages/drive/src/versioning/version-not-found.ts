/**
 * What a "not found" answer means when a run reads the content of a version it has just listed.
 *
 * A `404` or `410` there is not proof the version is gone. Graph answers it during incidents and
 * from replica lag, so does the download host that `/versions/{id}/content` redirects to, and
 * `with_graph_retry` never retries one. Counting it as expired let the file's watermark move past a
 * version Graph had listed moments earlier, and no later run asked for it again (issue #855).
 *
 * A version a retention policy purged leaves the version list, so the list is read again: a version
 * no longer in it is gone. One still listed counts as failed, holding the watermark back, until the
 * answer has repeated on enough runs across enough time that a passing fault is no longer a credible
 * cause. That is the rule a re-read of a failed item follows (issue #850), with the same thresholds.
 */

import type { NotFoundStreak } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { describe_graph_error } from '@wisecom/atlas-m365-graph';
import {
  describe_not_found_streak,
  extend_not_found_streak,
  is_not_found_confirmed,
} from '@wisecom/atlas-core/services/shared/not-found-streak';
import type { DriveContentConnector, DriveDeltaItem, DriveFileVersion } from '@/drive-ports';

/** How a "not found" answer on a listed version's content was judged. */
export type VersionNotFoundVerdict =
  { kind: 'gone' } | { kind: 'unconfirmed'; streak: NotFoundStreak };

/**
 * The file's version ids as Graph lists them now, read at most once per file and only when a
 * version's content answered "not found". Resolves `undefined` when the listing itself failed, which
 * confirms nothing.
 */
export type VersionRelisting = () => Promise<ReadonlySet<string> | undefined>;

/** A lazy, memoised re-read of the file's version list. */
export function create_version_relisting(
  connector: DriveContentConnector,
  item: DriveDeltaItem,
  abort_signal?: AbortSignal,
): VersionRelisting {
  let listed: Promise<ReadonlySet<string> | undefined> | undefined;
  return () => {
    listed ??= read_listed_version_ids(connector, item, abort_signal);
    return listed;
  };
}

async function read_listed_version_ids(
  connector: DriveContentConnector,
  item: DriveDeltaItem,
  abort_signal?: AbortSignal,
): Promise<ReadonlySet<string> | undefined> {
  try {
    const versions = await connector.list_file_versions(item.drive_id, item.item_id);
    return new Set(versions.map((version) => version.version_id));
  } catch (err) {
    if (abort_signal?.aborted === true) throw err;
    logger.warn(
      `Could not list the versions of ${item.file_name} again to check a "not found" answer: ` +
        describe_graph_error(err),
    );
    return undefined;
  }
}

/**
 * Judges a "not found" answer on one version's content: `gone` when the version has left the list
 * or the streak confirms it, and otherwise `unconfirmed` with the streak extended by this answer.
 */
export async function judge_version_not_found(
  relisting: VersionRelisting,
  item: DriveDeltaItem,
  version: DriveFileVersion,
  previous: NotFoundStreak | undefined,
  now: Date,
): Promise<VersionNotFoundVerdict> {
  const listed = await relisting();
  if (listed !== undefined && !listed.has(version.version_id)) {
    logger.debug(
      `Version ${version.version_id} of ${item.file_name} is no longer listed; treating it as expired`,
    );
    return { kind: 'gone' };
  }

  const streak = extend_not_found_streak(previous, now);
  if (is_not_found_confirmed(streak, now)) {
    logger.info(
      `Version ${version.version_id} of ${item.file_name} answered "not found" on ` +
        `${streak.reads} runs since ${streak.since}; treating it as expired`,
    );
    return { kind: 'gone' };
  }
  logger.warn(
    `Version ${version.version_id} of ${item.file_name} answered "not found" but is still listed ` +
      `(${describe_not_found_streak(streak, 'expired')})`,
  );
  return { kind: 'unconfirmed', streak };
}
