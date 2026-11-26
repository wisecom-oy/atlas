import type { NotFoundStreak, TenantContext } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { describe_graph_error, is_content_gone_error } from '@wisecom/atlas-m365-graph';
import { is_listed_size_part_limit_refusal } from '@wisecom/atlas-core/services/shared/multipart-part-plan';
import type {
  DriveContentConnector,
  DriveDeltaItem,
  DriveFileVersion,
  DriveFileVersionRecord,
  DriveVersionWatermark,
} from '@/drive-ports';
import type { DriveStorageKeys } from '@/shared/storage-keys';
import {
  store_version_content,
  VersionDownloadError,
  type StoredVersionContent,
} from '@/versioning/version-content-store';
import {
  by_version_age,
  is_version_already_captured,
  later_watermark,
} from '@/versioning/version-watermark';
import {
  create_version_relisting,
  judge_version_not_found,
  type VersionRelisting,
} from '@/versioning/version-not-found';

export interface VersionSyncResult {
  new_versions_stored: number;
  versions_deduplicated: number;
  versions_unavailable: number;
  versions_failed: number;
}

export interface VersionSyncOutcome extends VersionSyncResult {
  /** Rows captured by this file, destined for the run's single index object. */
  records: DriveFileVersionRecord[];
  /**
   * Watermark to persist for this file, or `undefined` to leave it untouched. Stops short of any
   * version this run failed to capture for an unexpected reason, so the next run retries it
   * instead of skipping past it.
   */
  next_watermark?: DriveVersionWatermark | string;
  /** Listed versions whose content still answers "not found", unconfirmed, by version id. */
  not_found?: Record<string, NotFoundStreak>;
}

/** What earlier runs recorded about one file's historical versions. */
export interface VersionHistoryState {
  readonly watermark?: DriveVersionWatermark | string | undefined;
  /** "Not found" streaks of listed versions, carried from the file's pending capture (issue #855). */
  readonly not_found?: Readonly<Record<string, NotFoundStreak>> | undefined;
}

/** A fresh outcome per call: `records` is a mutable array and must not be shared between files. */
function empty_outcome(): VersionSyncOutcome {
  return {
    new_versions_stored: 0,
    versions_deduplicated: 0,
    versions_unavailable: 0,
    versions_failed: 0,
    records: [],
  };
}

/**
 * Enumerates historical versions for a file and stores any not already captured, deciding that
 * from the file's dedup watermark rather than from the version index (issue #161).
 *
 * Versions are walked oldest first so the returned watermark can stop at the first version this
 * run could not capture:
 * - captured, or confirmed gone from Graph: the watermark advances past it, since a later run can
 *   neither improve on it nor ever see it again. A version whose content answers 404 or 410 is
 *   gone only once it has left the version list or the answer has repeated across runs
 *   (issue #855); until then it counts as failed.
 * - failed for any other reason: the watermark stops there, so the next run retries that version
 *   and everything after it
 *
 * Captured rows are returned to the caller rather than written here: the whole run shares one
 * index object, persisted at finalize time.
 */
export async function sync_file_versions(
  keys: DriveStorageKeys,
  connector: DriveContentConnector,
  item: DriveDeltaItem,
  owner_id: string,
  snapshot_id: string,
  ctx: TenantContext,
  history: VersionHistoryState,
  abort_signal?: AbortSignal,
): Promise<VersionSyncOutcome> {
  const versions = await connector.list_file_versions(item.drive_id, item.item_id);
  if (versions.length === 0) return empty_outcome();

  const outcome = await capture_new_versions(
    keys,
    connector,
    item,
    owner_id,
    snapshot_id,
    ctx,
    versions,
    history,
    abort_signal,
  );
  if (outcome.new_versions_stored > 0) {
    logger.info(
      `Stored ${outcome.new_versions_stored} historical version(s) for ${item.file_name}`,
    );
  }
  return outcome;
}

/** Walks the file's versions oldest first, capturing everything past the watermark. */
async function capture_new_versions(
  keys: DriveStorageKeys,
  connector: DriveContentConnector,
  item: DriveDeltaItem,
  owner_id: string,
  snapshot_id: string,
  ctx: TenantContext,
  versions: readonly DriveFileVersion[],
  history: VersionHistoryState,
  abort_signal?: AbortSignal,
): Promise<VersionSyncOutcome> {
  const { watermark } = history;
  const relisting = create_version_relisting(connector, item, abort_signal);
  const not_found: Record<string, NotFoundStreak> = {};
  const totals: VersionSyncResult = {
    new_versions_stored: 0,
    versions_deduplicated: 0,
    versions_unavailable: 0,
    versions_failed: 0,
  };
  const records: DriveFileVersionRecord[] = [];
  let next_watermark = watermark;
  let watermark_blocked = false;

  for (const version of [...versions].sort(by_version_age)) {
    if (is_version_already_captured(version.version_id, version.last_modified_at, watermark)) {
      continue;
    }

    const attempt = await capture_version(
      keys,
      connector,
      item,
      owner_id,
      snapshot_id,
      ctx,
      version,
      abort_signal,
    );
    const captured = await settle_not_found(attempt, relisting, item, version, history, not_found);
    // Not `||=`: that short-circuits once blocked and would stop tallying the remaining versions
    // entirely.
    if (!tally_capture(totals, records, captured)) watermark_blocked = true;
    if (!watermark_blocked) {
      next_watermark = later_watermark(
        next_watermark,
        version.last_modified_at,
        version.version_id,
      );
    }
  }

  return {
    ...totals,
    records,
    ...(next_watermark !== undefined && next_watermark !== watermark ? { next_watermark } : {}),
    ...(Object.keys(not_found).length > 0 ? { not_found } : {}),
  };
}

/**
 * Turns a "not found" content read into `gone` or `failed` (issue #855), recording the streak of an
 * unconfirmed one in `not_found`. Any other capture passes through unchanged.
 */
async function settle_not_found(
  attempt: VersionAttempt,
  relisting: VersionRelisting,
  item: DriveDeltaItem,
  version: DriveFileVersion,
  history: VersionHistoryState,
  not_found: Record<string, NotFoundStreak>,
): Promise<VersionCapture> {
  if (attempt.kind !== 'not_found') return attempt;
  const previous = history.not_found?.[version.version_id];
  const verdict = await judge_version_not_found(relisting, item, version, previous, new Date());
  if (verdict.kind === 'gone') return { kind: 'gone' };
  not_found[version.version_id] = verdict.streak;
  return { kind: 'failed' };
}

/**
 * Folds one capture into the run totals. Returns whether the file's watermark may still advance
 * past this version, which is false only for a version that might yet be retrievable on a later
 * run.
 */
function tally_capture(
  totals: VersionSyncResult,
  records: DriveFileVersionRecord[],
  captured: VersionCapture,
): boolean {
  if (captured.kind === 'failed') {
    totals.versions_failed++;
    return false;
  }
  if (captured.kind === 'gone') {
    totals.versions_unavailable++;
    return true;
  }
  records.push(captured.record);
  if (captured.deduplicated) totals.versions_deduplicated++;
  else totals.new_versions_stored++;
  return true;
}

type VersionCapture =
  | { kind: 'stored'; record: DriveFileVersionRecord; deduplicated: boolean }
  | { kind: 'gone' }
  | { kind: 'failed' };

/** One download attempt, before a "not found" answer has been judged. */
type VersionAttempt = VersionCapture | { kind: 'not_found' };

/**
 * Downloads one historical version, stores it content-addressed, and builds its index row.
 * `not_found` means the content read answered 404 or 410, which the caller still has to judge;
 * `failed` means the version may still be retrievable and the run should come back for it.
 * `gone` here means the version is too large to store at all, which no later run can change
 * (issue #925), so it is counted unavailable and the watermark moves past it.
 */
async function capture_version(
  keys: DriveStorageKeys,
  connector: DriveContentConnector,
  item: DriveDeltaItem,
  owner_id: string,
  snapshot_id: string,
  ctx: TenantContext,
  version: DriveFileVersion,
  abort_signal?: AbortSignal,
): Promise<VersionAttempt> {
  let stored: StoredVersionContent;
  try {
    stored = await store_version_content(
      keys,
      connector,
      item,
      owner_id,
      ctx,
      version,
      abort_signal,
    );
  } catch (err) {
    // A cancelled run is not a version that failed to download: recording it as failed would block
    // the watermark and re-fetch it next run for no reason (issue #344).
    if (abort_signal?.aborted === true) throw err;
    if (is_listed_size_part_limit_refusal(err)) {
      logger.warn(`Version ${version.version_id} of ${item.file_name} not stored: ${err.message}`);
      return { kind: 'gone' };
    }
    if (!(err instanceof VersionDownloadError)) throw err;
    if (is_content_gone_error(err.source)) return { kind: 'not_found' };
    logger.warn(
      `Version ${version.version_id} of ${item.file_name}: ${describe_graph_error(err.source)}`,
    );
    return { kind: 'failed' };
  }

  return {
    kind: 'stored',
    deduplicated: stored.deduplicated,
    record: {
      snapshot_id,
      backup_at: new Date().toISOString(),
      drive_id: item.drive_id,
      file_name: item.file_name,
      parent_path: item.parent_path,
      version_id: version.version_id,
      size_bytes: version.size_bytes,
      ...(version.last_modified_by !== undefined && {
        last_modified_by: version.last_modified_by,
      }),
      storage_key: stored.storage_key,
      checksum: stored.checksum,
      last_modified_at: version.last_modified_at,
      change_type: 'updated',
    },
  };
}
