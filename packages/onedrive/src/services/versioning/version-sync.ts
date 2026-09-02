import type {
  OneDriveConnector,
  OneDriveDeltaItem,
  OneDriveVersionWatermark,
  TenantContext,
} from '@wisecom/atlas-types';
import {
  sync_file_versions as sync_drive_file_versions,
  type VersionSyncOutcome,
} from '@wisecom/atlas-drive/versioning/version-sync';
import { ONEDRIVE_KEYS } from '@/services/shared/storage-keys';

export {
  collect_run_versions,
  type RunVersionCollector,
  type VersionSyncOutcome,
  type VersionSyncResult,
} from '@wisecom/atlas-drive/versioning/version-sync';

/** Stores every historical version of the file that the dedup watermark does not already cover. */
export async function sync_file_versions(
  connector: OneDriveConnector,
  item: OneDriveDeltaItem,
  owner_id: string,
  snapshot_id: string,
  ctx: TenantContext,
  watermark: OneDriveVersionWatermark | string | undefined,
): Promise<VersionSyncOutcome> {
  return sync_drive_file_versions(
    ONEDRIVE_KEYS,
    connector,
    item,
    owner_id,
    snapshot_id,
    ctx,
    watermark,
  );
}
