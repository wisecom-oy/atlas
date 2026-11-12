import type {
  BackupProgressReporter,
  MailboxConnector,
  MailFolder,
  SyncOptions,
  TenantContext,
} from '@wisecom/atlas-types';
import { sync_single_folder, type FolderSyncResult } from '@/services/backup/folder-sync-executor';
import { failed_folder_result } from '@/services/backup/failed-folder-result';

/** Syncs one folder and updates progress; returns aggregated results or an error message. */
export async function sync_folder_with_progress(
  connector: MailboxConnector,
  ctx: TenantContext,
  tenant_id: string,
  owner_id: string,
  folder: MailFolder,
  folder_index: number,
  saved_links: Record<string, string>,
  previous_entry_count: number,
  global_total: number,
  global_processed_before: number,
  sync_start: number,
  progress: BackupProgressReporter,
  options: SyncOptions,
  should_interrupt: () => boolean,
  should_force_stop: () => boolean,
): Promise<FolderSyncResult & { error?: string }> {
  try {
    const prev_link = saved_links[folder.folder_id];
    const result = await sync_single_folder({
      ctx,
      connector,
      tenant_id,
      owner_id,
      folder_id: folder.folder_id,
      folder_index,
      folder_total: folder.total_item_count,
      global_total,
      global_processed_before,
      sync_start,
      progress,
      is_interrupted: should_interrupt,
      is_hard_stopped: should_force_stop,
      operation_control: options,
      ...(prev_link !== undefined ? { prev_delta_link: prev_link } : {}),
      previous_manifest_entries: previous_entry_count,
      ...(options.page_size !== undefined ? { page_size: options.page_size } : {}),
      ...(options.object_lock_policy !== undefined
        ? { object_lock_policy: options.object_lock_policy }
        : {}),
    });
    return {
      ...result,
      // Marked here rather than inside the executor: the folder knows where
      // it came from, the message pipeline has no reason to.
      entries:
        folder.is_recoverable_items === true
          ? result.entries.map((entry) => ({ ...entry, recoverable_items: true }))
          : result.entries,
    };
  } catch (err) {
    return failed_folder_result(err, options);
  }
}
