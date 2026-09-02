import type {
  SharePointDeltaItem,
  SharePointSiteConnector,
  SharePointVersionWatermark,
  TenantContext,
} from '@wisecom/atlas-types';
import {
  sync_file_versions as sync_drive_file_versions,
  type VersionSyncOutcome,
} from '@wisecom/atlas-drive/versioning/version-sync';
import { SHAREPOINT_KEYS } from '@/services/shared/storage-keys';

export {
  collect_run_versions,
  type RunVersionCollector,
  type VersionSyncOutcome,
  type VersionSyncResult,
} from '@wisecom/atlas-drive/versioning/version-sync';

/** Stores every historical version of the file that the dedup watermark does not already cover. */
export async function sync_file_versions(
  connector: SharePointSiteConnector,
  item: SharePointDeltaItem,
  site_id: string,
  snapshot_id: string,
  ctx: TenantContext,
  watermark: SharePointVersionWatermark | string | undefined,
): Promise<VersionSyncOutcome> {
  return sync_drive_file_versions(
    SHAREPOINT_KEYS,
    connector,
    item,
    site_id,
    snapshot_id,
    ctx,
    watermark,
  );
}
