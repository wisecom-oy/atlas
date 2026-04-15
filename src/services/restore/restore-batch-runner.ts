import type { TenantContext } from '@/ports/tenant/context.port';
import type { RestoreConnector } from '@/ports/restore/connector.port';
import type { MailboxConnector } from '@/ports/mailbox/connector.port';
import type { ManifestEntry } from '@/domain/manifest';
import type { RestoreResult } from '@/ports/restore/use-case.port';
import {
  build_folder_map,
  create_restore_root,
  ensure_subfolder,
  group_entries_by_folder,
  count_unique_folders,
} from '@/services/restore/folder-restore-planner';
import {
  restore_folder_entries,
  backfill_missing_folder_ids,
  log_restore_summary,
} from '@/services/restore/restore-execution-orchestrator';
import { verify_folder_message_count } from '@/services/restore/restore-folder-verifier';
import { RestoreProgressDashboard } from '@/services/restore/restore-progress-dashboard';
import { calc_rate } from '@/services/shared/progress-rate';
import { logger } from '@/utils/logger';

interface BatchContext {
  ctx: TenantContext;
  connector: MailboxConnector;
  restore_connector: RestoreConnector;
  tenant_id: string;
  source_mailbox: string;
  target_mailbox: string;
  snapshot_id: string;
  entries: ManifestEntry[];
  is_interrupted: () => boolean;
}

/** Restores a batch of messages with dashboard progress and verification. */
export async function run_restore_batch(bc: BatchContext): Promise<RestoreResult> {
  const folder_map = await build_folder_map(bc.connector, bc.tenant_id, bc.source_mailbox);
  await backfill_missing_folder_ids(bc.ctx, bc.entries);

  const groups = group_entries_by_folder(bc.entries);
  const root = await create_restore_root(bc.restore_connector, bc.tenant_id, bc.target_mailbox);
  const created_folders = new Map<string, string>();

  logger.info(
    `Restoring ${bc.entries.length} messages across ` +
      `${count_unique_folders(bc.entries)} folders into ${root.display_name}`,
  );

  const dashboard = new RestoreProgressDashboard(
    [...groups.entries()].map(([fid, items]) => ({
      name: folder_map.get(fid) ?? fid.slice(0, 12),
      total_items: items.length,
    })),
  );

  return execute_restore_loop(bc, root, groups, folder_map, created_folders, dashboard);
}

async function execute_restore_loop(
  bc: BatchContext,
  root: { folder_id: string; display_name: string },
  groups: Map<string, ManifestEntry[]>,
  folder_map: Map<string, string>,
  created_folders: Map<string, string>,
  dashboard: RestoreProgressDashboard,
): Promise<RestoreResult> {
  let global_restored = 0;
  let global_att = 0;
  let global_errors = 0;
  let global_att_errors = 0;
  let global_verification_failures = 0;
  const all_errors: string[] = [];
  const all_att_errors: string[] = [];
  const verification_warnings: string[] = [];
  const start = Date.now();
  const global_total = [...groups.values()].reduce((s, g) => s + g.length, 0);

  let folder_index = 0;
  for (const [fid, folder_items] of groups) {
    if (bc.is_interrupted()) break;
    dashboard.mark_active(folder_index);

    const target_fid = await ensure_subfolder(
      bc.restore_connector,
      bc.tenant_id,
      bc.target_mailbox,
      root.folder_id,
      fid,
      folder_map,
      created_folders,
    );

    const result = await restore_folder_entries(
      bc.ctx,
      bc.restore_connector,
      bc.tenant_id,
      bc.target_mailbox,
      target_fid,
      folder_items,
      folder_index,
      global_restored,
      global_total,
      start,
      dashboard,
      bc.is_interrupted,
    );

    global_restored += result.restored;
    global_att += result.attachments;
    global_att_errors += result.attachment_errors;
    global_errors += result.errors.length;
    all_errors.push(...result.errors);
    all_att_errors.push(...result.att_error_details);

    const vf = await verify_folder_message_count(
      bc.restore_connector,
      bc.tenant_id,
      bc.target_mailbox,
      target_fid,
      result.restored,
      folder_map.get(fid) ?? fid.slice(0, 12),
    );
    if (vf.api_failed) {
      verification_warnings.push(
        `Folder "${folder_map.get(fid) ?? fid.slice(0, 12)}": unable to confirm message count`,
      );
    } else if (vf.missing > 0) {
      global_verification_failures += vf.missing;
      verification_warnings.push(
        `Folder "${folder_map.get(fid) ?? fid.slice(0, 12)}": ${vf.missing} message(s) may not have persisted`,
      );
    }

    const rate = calc_rate(global_restored, Date.now() - start);
    const eta = rate > 0 ? (global_total - global_restored) / rate : 0;
    dashboard.update_total(global_restored, global_total, rate, eta);

    if (bc.is_interrupted()) break;
    dashboard.mark_done(folder_index, result.restored, result.attachments);
    folder_index++;
  }

  if (bc.is_interrupted()) dashboard.mark_all_pending_interrupted();
  dashboard.finish(global_restored);
  log_restore_summary(global_restored, global_att, global_errors, start);

  return {
    snapshot_id: bc.snapshot_id,
    restored_count: global_restored,
    attachment_count: global_att,
    error_count: global_errors,
    attachment_error_count: global_att_errors,
    verification_failures: global_verification_failures,
    errors: all_errors,
    attachment_errors: all_att_errors,
    verification_warnings,
    restore_folder_name: root.display_name,
  };
}
