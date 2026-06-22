import type { TenantContext } from '@atlas/types';
import type { ManifestEntry } from '@atlas/types';
import type { RestoreConnector } from '@atlas/types';
import type { RestoreResult } from '@atlas/types';
import { calc_rate } from '@atlas/core/services/shared/progress-rate';
import { ensure_subfolder } from '@/services/restore/folder-restore-planner';
import {
  log_restore_summary,
  restore_folder_entries,
} from '@/services/restore/restore-execution-orchestrator';
import type { RestoreProgressDashboard } from '@/services/restore/restore-progress-dashboard';

/** Iterates folder groups and restores messages with dashboard progress and SIGINT handling. */
export async function execute_restore_loop(
  ctx: TenantContext,
  restore_connector: RestoreConnector,
  tenant_id: string,
  target_mailbox: string,
  snapshot_id: string,
  root: { folder_id: string; display_name: string },
  groups: Map<string, ManifestEntry[]>,
  folder_map: Map<string, string>,
  created_folders: Map<string, string>,
  dashboard: RestoreProgressDashboard,
): Promise<RestoreResult> {
  let global_restored = 0;
  let global_att = 0;
  let global_errors = 0;
  const all_errors: string[] = [];
  const start = Date.now();
  const global_total = [...groups.values()].reduce((s, g) => s + g.length, 0);

  let interrupted = false;
  const on_sigint = (): void => {
    interrupted = true;
  };
  process.on('SIGINT', on_sigint);

  try {
    let folder_index = 0;
    for (const [fid, folder_items] of groups) {
      if (interrupted) break;
      dashboard.mark_active(folder_index);

      const target_fid = await ensure_subfolder(
        restore_connector,
        tenant_id,
        target_mailbox,
        root.folder_id,
        fid,
        folder_map,
        created_folders,
      );

      const result = await restore_folder_entries(
        ctx,
        restore_connector,
        tenant_id,
        target_mailbox,
        target_fid,
        folder_items,
        folder_index,
        global_restored,
        global_total,
        start,
        dashboard,
        () => interrupted,
      );

      global_restored += result.restored;
      global_att += result.attachments;
      global_errors += result.errors.length;
      all_errors.push(...result.errors);

      const rate = calc_rate(global_restored, Date.now() - start);
      const eta = rate > 0 ? (global_total - global_restored) / rate : 0;
      dashboard.update_total(global_restored, global_total, rate, eta);

      if (interrupted) break;
      dashboard.mark_done(folder_index, result.restored, result.attachments);
      folder_index++;
    }

    if (interrupted) dashboard.mark_all_pending_interrupted();
    dashboard.finish(global_restored);
    log_restore_summary(global_restored, global_att, global_errors, start);

    return {
      snapshot_id,
      restored_count: global_restored,
      attachment_count: global_att,
      error_count: global_errors,
      attachment_error_count: 0,
      errors: all_errors,
      verification_warnings: [],
      restore_folder_name: root.display_name,
    };
  } finally {
    process.removeListener('SIGINT', on_sigint);
  }
}
