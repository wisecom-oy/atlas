import type { TenantContext } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { describe_graph_error, is_content_gone_error } from '@wisecom/atlas-m365-graph';
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
}

/**
 * Per-run version bookkeeping shared by every delta item of a backup. `watermarks` is carried in
 * and out through the delta cursor, so version dedup costs no index reads at all; `rows`
 * accumulates what this run captured for its single index object (issue #161).
 */
export interface RunVersionCollector {
  watermarks: Record<string, DriveVersionWatermark | string>;
  rows: Map<string, DriveFileVersionRecord[]>;
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
 * Records what one file's sync captured: the index rows for this run, and the advanced watermark.
 * Writing the watermark back immediately also means a file that appears twice in one delta cycle
 * is not downloaded twice.
 */
export function collect_run_versions(
  versions: RunVersionCollector,
  file_id: string,
  outcome: VersionSyncOutcome,
): void {
  if (outcome.records.length > 0) {
    const rows = versions.rows.get(file_id);
    if (rows) rows.push(...outcome.records);
    else versions.rows.set(file_id, [...outcome.records]);
  }
  if (outcome.next_watermark !== undefined) {
    versions.watermarks[file_id] = outcome.next_watermark;
  }
}

/**
 * Enumerates historical versions for a file and stores any not already captured, deciding that
 * from the file's dedup watermark rather than from the version index (issue #161).
 *
 * Versions are walked oldest first so the returned watermark can stop at the first version this
 * run could not capture:
 * - captured, or permanently gone from Graph (404/410, expired by the library's version policy):
 *   the watermark advances past it, since a later run can neither improve on it nor ever see it
 *   again
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
  watermark: DriveVersionWatermark | string | undefined,
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
    watermark,
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
  watermark: DriveVersionWatermark | string | undefined,
): Promise<VersionSyncOutcome> {
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

    const captured = await capture_version(
      keys,
      connector,
      item,
      owner_id,
      snapshot_id,
      ctx,
      version,
    );
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
  };
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

/**
 * Downloads one historical version, stores it content-addressed, and builds its index row. `gone`
 * means Graph no longer has the version at all, which is expected once a library's version policy
 * expires it; `failed` means the version may still be retrievable and the run should come back
 * for it.
 */
async function capture_version(
  keys: DriveStorageKeys,
  connector: DriveContentConnector,
  item: DriveDeltaItem,
  owner_id: string,
  snapshot_id: string,
  ctx: TenantContext,
  version: DriveFileVersion,
): Promise<VersionCapture> {
  let stored: StoredVersionContent;
  try {
    stored = await store_version_content(keys, connector, item, owner_id, ctx, version);
  } catch (err) {
    if (!(err instanceof VersionDownloadError)) throw err;
    if (is_content_gone_error(err.source)) {
      logger.debug(
        `Version ${version.version_id} of ${item.file_name} no longer available (expired)`,
      );
      return { kind: 'gone' };
    }
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
