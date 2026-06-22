import { createHash } from 'node:crypto';
import type {
  OneDriveConnector,
  OneDriveDeltaItem,
  OneDriveFileVersion,
  OneDriveFileVersionIndexRepository,
  OneDriveFileVersionRecord,
  TenantContext,
} from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { onedrive_data_key } from '@/services/onedrive-storage-keys';

export interface VersionSyncResult {
  readonly new_versions_stored: number;
  readonly versions_deduplicated: number;
  readonly versions_unavailable: number;
  readonly versions_failed: number;
}

type VersionDownloadOutcome =
  | { status: 'ok'; content: Buffer }
  | { status: 'unavailable' }
  | { status: 'failed'; reason: string };

const EMPTY_RESULT: VersionSyncResult = {
  new_versions_stored: 0,
  versions_deduplicated: 0,
  versions_unavailable: 0,
  versions_failed: 0,
};

/**
 * Enumerates historical versions for a file and stores any that are new.
 * Compares against the existing version index to avoid re-downloading
 * versions already captured in previous syncs.
 */
export async function sync_file_versions(
  connector: OneDriveConnector,
  item: OneDriveDeltaItem,
  owner_id: string,
  snapshot_id: string,
  ctx: TenantContext,
  file_indexes: OneDriveFileVersionIndexRepository,
): Promise<VersionSyncResult> {
  const versions = await connector.list_file_versions(item.drive_id, item.item_id);
  if (versions.length === 0) return EMPTY_RESULT;

  const existing_index = await file_indexes.find_by_file_id(ctx, owner_id, item.item_id);
  const known_version_ids = new Set(
    (existing_index?.versions ?? []).map((v) => v.version_id).filter(Boolean) as string[],
  );

  let new_versions_stored = 0;
  let versions_deduplicated = 0;
  let versions_unavailable = 0;
  let versions_failed = 0;

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

    const record: OneDriveFileVersionRecord = {
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
    };

    await file_indexes.append_version(ctx, owner_id, item.item_id, record);
  }

  if (new_versions_stored > 0) {
    logger.info(`Stored ${new_versions_stored} historical version(s) for ${item.file_name}`);
  }

  return { new_versions_stored, versions_deduplicated, versions_unavailable, versions_failed };
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
    if (is_version_unavailable(err)) {
      logger.debug(
        `Version ${version.version_id} of ${item.file_name} no longer available (expired)`,
      );
      return { status: 'unavailable' };
    }
    const reason = err instanceof Error ? err.message : String(err);
    return { status: 'failed', reason };
  }
}

/** HTTP 404/410 indicate the version content has been purged by retention policy. */
function is_version_unavailable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const status =
    (err as Record<string, unknown>).statusCode ?? (err as Record<string, unknown>).status;
  if (status === 404 || status === 410) return true;
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('404') || message.includes('Not Found') || message.includes('410');
}
