import { createHash } from 'node:crypto';
import type {
  OneDriveConnector,
  OneDriveDeltaItem,
  OneDriveFileVersion,
  OneDriveFileVersionRecord,
  TenantContext,
} from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { describe_graph_error, is_content_gone_error } from '@wisecom/atlas-m365-graph';
import { onedrive_data_key } from '@/services/onedrive-storage-keys';

export interface VersionSyncResult {
  new_versions_stored: number;
  versions_deduplicated: number;
  versions_unavailable: number;
  versions_failed: number;
}

export interface VersionSyncOutcome extends VersionSyncResult {
  /** Rows captured by this file, destined for the run's single index object. */
  records: OneDriveFileVersionRecord[];
}

/**
 * Per-run version bookkeeping shared by every delta item of a backup:
 * `known` is preloaded once from the existing index objects, and `rows`
 * accumulates what this run captured for its single index object.
 */
export interface RunVersionCollector {
  known: Map<string, Set<string>>;
  rows: Map<string, OneDriveFileVersionRecord[]>;
}

type VersionDownloadOutcome =
  | { status: 'ok'; content: Buffer }
  | { status: 'unavailable' }
  | { status: 'failed'; reason: string };

const EMPTY_OUTCOME: VersionSyncOutcome = {
  new_versions_stored: 0,
  versions_deduplicated: 0,
  versions_unavailable: 0,
  versions_failed: 0,
  records: [],
};

/**
 * Records what one file's sync captured. The version ids are folded into
 * `known` as well: it is preloaded once per run, so without this a file that
 * appears twice in the same delta cycle would be downloaded and recorded
 * twice.
 */
export function collect_run_versions(
  versions: RunVersionCollector,
  file_id: string,
  records: readonly OneDriveFileVersionRecord[],
): void {
  if (records.length === 0) return;
  const rows = versions.rows.get(file_id);
  if (rows) rows.push(...records);
  else versions.rows.set(file_id, [...records]);
  let known = versions.known.get(file_id);
  if (!known) versions.known.set(file_id, (known = new Set<string>()));
  for (const record of records) {
    if (record.version_id) known.add(record.version_id);
  }
}

/**
 * Enumerates historical versions for a file and stores any that are new.
 * Compares against the version ids already recorded by earlier runs
 * (`known_version_ids`, preloaded once per run) to avoid re-downloading
 * them. Captured rows are returned to the caller instead of written here:
 * the whole run shares one index object, persisted at finalize time
 * (issue #161).
 */
export async function sync_file_versions(
  connector: OneDriveConnector,
  item: OneDriveDeltaItem,
  owner_id: string,
  snapshot_id: string,
  ctx: TenantContext,
  known_version_ids: ReadonlySet<string>,
): Promise<VersionSyncOutcome> {
  const versions = await connector.list_file_versions(item.drive_id, item.item_id);
  if (versions.length === 0) return EMPTY_OUTCOME;

  let new_versions_stored = 0;
  let versions_deduplicated = 0;
  let versions_unavailable = 0;
  let versions_failed = 0;
  const records: OneDriveFileVersionRecord[] = [];

  for (const version of versions) {
    if (known_version_ids.has(version.version_id)) continue;

    const outcome = await download_version_classified(connector, item, version);

    if (outcome.status === 'unavailable') {
      versions_unavailable++;
      continue;
    }

    if (outcome.status === 'failed') {
      versions_failed++;
      logger.warn(`Version ${version.version_id} of ${item.file_name}: ${outcome.reason}`);
      continue;
    }

    const checksum = createHash('sha256').update(outcome.content).digest('hex');
    const storage_key = onedrive_data_key(owner_id, checksum);
    const exists = await ctx.storage.exists(storage_key);

    if (!exists) {
      await ctx.storage.put(storage_key, ctx.encrypt(outcome.content));
      new_versions_stored++;
    } else {
      versions_deduplicated++;
    }

    records.push({
      snapshot_id,
      backup_at: new Date().toISOString(),
      drive_id: item.drive_id,
      file_name: item.file_name,
      parent_path: item.parent_path,
      version_id: version.version_id,
      size_bytes: version.size_bytes,
      storage_key,
      checksum,
      last_modified_at: version.last_modified_at,
      change_type: 'updated',
    });
  }

  if (new_versions_stored > 0) {
    logger.info(`Stored ${new_versions_stored} historical version(s) for ${item.file_name}`);
  }

  return {
    new_versions_stored,
    versions_deduplicated,
    versions_unavailable,
    versions_failed,
    records,
  };
}

/**
 * Attempts to download a version, classifying the outcome:
 * - 404/410: version expired by retention policy (unavailable, expected)
 * - Other errors: unexpected failure worth reporting
 */
async function download_version_classified(
  connector: OneDriveConnector,
  item: OneDriveDeltaItem,
  version: OneDriveFileVersion,
): Promise<VersionDownloadOutcome> {
  try {
    const content = await connector.download_file_version(
      item.drive_id,
      item.item_id,
      version.version_id,
    );
    return { status: 'ok', content };
  } catch (err) {
    if (is_content_gone_error(err)) {
      logger.debug(
        `Version ${version.version_id} of ${item.file_name} no longer available (expired)`,
      );
      return { status: 'unavailable' };
    }
    return { status: 'failed', reason: describe_graph_error(err) };
  }
}
