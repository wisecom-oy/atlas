import type { TenantContext } from '@wisecom/atlas-types';
import type { ManifestEntry } from '@wisecom/atlas-types';
import type { RestoreConnector } from '@wisecom/atlas-types';
import type { RestoreResult, RestoredMessageReport } from '@wisecom/atlas-types';
import { calc_rate } from '@wisecom/atlas-core/services/shared/progress-rate';
import { append_all } from '@wisecom/atlas-core/utils/append-all';
import {
  emit_operation_progress,
  finish_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
import { ensure_subfolder } from '@/services/restore/folder-restore-planner';
import {
  log_restore_summary,
  restore_folder_entries,
} from '@/services/restore/restore-execution-orchestrator';
import type { OperationControlOptions, TransferProgressReporter } from '@wisecom/atlas-types';

/** True once the caller asked the run to stop, by flag or by abort signal. */
function is_run_interrupted(control: OperationControlOptions): boolean {
  return control.should_interrupt?.() === true || control.abort_signal?.aborted === true;
}

/** Creates the restore-side folder for one source folder, or says why it could not be created. */
async function open_target_folder(
  restore_connector: RestoreConnector,
  tenant_id: string,
  target_mailbox: string,
  root_folder_id: string,
  fid: string,
  folder_map: Map<string, string>,
  created_folders: Map<string, string>,
): Promise<{ readonly folder_id: string } | { readonly error: string }> {
  try {
    const folder_id = await ensure_subfolder(
      restore_connector,
      tenant_id,
      target_mailbox,
      root_folder_id,
      fid,
      folder_map,
      created_folders,
    );
    return { folder_id };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { error: `folder ${folder_map.get(fid) ?? fid}: could not be created (${reason})` };
  }
}

/**
 * Iterates folder groups and restores messages with dashboard progress.
 *
 * Interruption reaches it only through `should_interrupt` and `abort_signal`. Its own SIGINT
 * listener used to suppress Node's default exit, so no number of Ctrl+C presses ended a run
 * parked in a Graph wait (issue #682).
 */
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
  dashboard: TransferProgressReporter,
  control: OperationControlOptions = {},
): Promise<RestoreResult> {
  let global_restored = 0;
  let global_att = 0;
  let global_errors = 0;
  let global_att_errors = 0;
  const all_errors: string[] = [];
  const messages: RestoredMessageReport[] = [];
  const warnings: string[] = [];
  const start = Date.now();
  const global_total = [...groups.values()].reduce((s, g) => s + g.length, 0);

  const is_interrupted = (): boolean => is_run_interrupted(control);

  emit_operation_progress(control, {
    operation: 'restore',
    workload: 'outlook',
    phase: 'processing',
    processed: 0,
    total: global_total,
  });
  let folder_index = 0;
  for (const [fid, folder_items] of groups) {
    if (is_interrupted()) break;
    dashboard.mark_active(folder_index);

    // A folder that cannot be created costs its own messages, not the rest of the plan. The
    // drive restores have always degraded per folder; this was the one path where one Graph
    // 4xx on create_mail_folder aborted the run and left every later folder untouched, in a
    // state indistinguishable from an interrupt (issue #360).
    const target = await open_target_folder(
      restore_connector,
      tenant_id,
      target_mailbox,
      root.folder_id,
      fid,
      folder_map,
      created_folders,
    );
    // A create cut short by Ctrl+C is the run stopping, not a folder that cannot exist (#682).
    if (is_interrupted()) break;
    if ('error' in target) {
      all_errors.push(`${target.error}; ${folder_items.length} message(s) not restored`);
      global_errors++;
      dashboard.mark_done(folder_index, 0, 0);
      folder_index++;
      continue;
    }
    const target_fid = target.folder_id;

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
      is_interrupted,
      control,
    );

    global_restored += result.restored;
    global_att += result.attachments;
    global_errors += result.errors.length;
    append_all(all_errors, result.errors);
    append_all(all_errors, result.attachment_errors);
    global_att_errors += result.attachment_errors.length;
    append_all(messages, result.messages);
    append_all(warnings, result.warnings);

    const rate = calc_rate(global_restored, Date.now() - start);
    const eta = rate > 0 ? (global_total - global_restored) / rate : 0;
    dashboard.update_total(global_restored, global_total, rate, eta);

    if (is_interrupted()) break;
    dashboard.mark_done(folder_index, result.restored, result.attachments);
    folder_index++;
  }

  const interrupted_before_finalization = is_interrupted();
  if (interrupted_before_finalization) dashboard.mark_all_pending_interrupted();
  dashboard.finish(global_restored);
  log_restore_summary(global_restored, global_att, global_errors, start);
  const was_interrupted = finish_operation_progress(
    control,
    'restore',
    'outlook',
    global_restored,
    global_total,
    interrupted_before_finalization,
  );

  return {
    snapshot_id,
    restored_count: global_restored,
    attachment_count: global_att,
    error_count: global_errors,
    attachment_error_count: global_att_errors,
    errors: all_errors,
    verification_warnings: warnings,
    messages,
    restore_folder_name: root.display_name,
    interrupted: was_interrupted,
  };
}
