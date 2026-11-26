import type {
  SharePointSiteConnector,
  SharePointDeltaItem,
  TenantContext,
} from '@wisecom/atlas-types';
import {
  sync_file_versions as sync_drive_file_versions,
  type VersionHistoryState,
  type VersionSyncOutcome,
} from '@wisecom/atlas-drive/versioning/version-sync';
import { capture_owed_file_versions as capture_owed_drive_file_versions } from '@wisecom/atlas-drive/versioning/owed-version-capture';
import type { RunVersionCollector } from '@wisecom/atlas-drive/versioning/run-version-collector';
import { SHAREPOINT_KEYS } from '@/services/shared/storage-keys';

export {
  type VersionHistoryState,
  type VersionSyncOutcome,
  type VersionSyncResult,
} from '@wisecom/atlas-drive/versioning/version-sync';
export {
  collect_run_versions,
  forget_pending_versions,
  type RunVersionCollector,
} from '@wisecom/atlas-drive/versioning/run-version-collector';

/** Stores every historical version of the file that the dedup watermark does not already cover. */
export async function sync_file_versions(
  connector: SharePointSiteConnector,
  item: SharePointDeltaItem,
  site_id: string,
  snapshot_id: string,
  ctx: TenantContext,
  history: VersionHistoryState,
  abort_signal?: AbortSignal,
): Promise<VersionSyncOutcome> {
  return sync_drive_file_versions(
    SHAREPOINT_KEYS,
    connector,
    item,
    site_id,
    snapshot_id,
    ctx,
    history,
    abort_signal,
  );
}

/**
 * Captures the file's historical versions when its content was just stored or an earlier capture
 * did not finish; `undefined` when nothing was owed and Graph was not asked (issue #858).
 */
export async function capture_owed_file_versions(
  connector: SharePointSiteConnector,
  item: SharePointDeltaItem,
  site_id: string,
  snapshot_id: string,
  ctx: TenantContext,
  versions: RunVersionCollector,
  content_deduplicated: boolean,
  abort_signal?: AbortSignal,
): Promise<VersionSyncOutcome | undefined> {
  return capture_owed_drive_file_versions(
    SHAREPOINT_KEYS,
    connector,
    item,
    site_id,
    snapshot_id,
    ctx,
    versions,
    content_deduplicated,
    abort_signal,
  );
}
