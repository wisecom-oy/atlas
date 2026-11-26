import type {
  ManifestEntry,
  OperationControlOptions,
  OutcomeUnknownMessage,
  RestoreConnector,
  RestoredMessageReport,
  TenantContext,
  TransferProgressReporter,
} from '@wisecom/atlas-types';
import { is_active_run_cancelled } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { emit_operation_progress } from '@wisecom/atlas-core/services/shared/operation-progress';
import { calc_rate } from '@wisecom/atlas-core/services/shared/progress-rate';
import {
  is_run_fatal_error,
  type RunFatalError,
} from '@wisecom/atlas-core/services/shared/run-fatal-error';
import { append_all } from '@wisecom/atlas-core/utils/append-all';
import {
  type EntryRestoreOutcome,
  restore_one_entry,
} from '@/services/restore/restore-execution-orchestrator';
import { attachment_shortfall_warning } from '@/services/restore/restored-message-report';
import {
  unknown_attachment_creates,
  unknown_message_create,
} from '@/services/restore/outcome-unknown-messages';
import { WriteOutcomeUnknownError } from '@wisecom/atlas-types';

/** What one folder's restore produced. */
export interface FolderRestoreTally {
  restored: number;
  attachments: number;
  readonly errors: string[];
  readonly attachment_errors: string[];
  readonly messages: RestoredMessageReport[];
  readonly warnings: string[];
  /** Messages and attachments among the errors whose create may have committed (issue #893). */
  readonly outcome_unknown: OutcomeUnknownMessage[];
  /** A refusal for the whole mailbox that stopped the folder; it ends the restore (#871). */
  refusal?: RunFatalError;
}

/** Where a folder sits in the run, for the dashboard and progress events. */
interface FolderProgress {
  readonly folder_index: number;
  readonly global_before: number;
  readonly global_total: number;
  readonly start: number;
  readonly dashboard: TransferProgressReporter;
  readonly control: OperationControlOptions;
}

/**
 * Restores all entries for a single folder, updating dashboard per-message. Stops at an
 * `AuthError` or `MailboxNotLicensedError` and returns it as `refusal`, with what came before.
 */
export async function restore_folder_entries(
  ctx: TenantContext,
  restore_connector: RestoreConnector,
  tenant_id: string,
  owner_id: string,
  target_folder_id: string,
  entries: ManifestEntry[],
  folder_index: number,
  global_before: number,
  global_total: number,
  start: number,
  dashboard: TransferProgressReporter,
  is_interrupted: () => boolean,
  control: OperationControlOptions,
): Promise<FolderRestoreTally> {
  const tally = empty_tally();
  const progress = { folder_index, global_before, global_total, start, dashboard, control };

  for (const entry of entries) {
    if (is_interrupted()) break;
    try {
      const outcome = await restore_one_entry(
        ctx,
        restore_connector,
        tenant_id,
        owner_id,
        target_folder_id,
        entry,
      );
      record_restored_message(tally, entry, target_folder_id, outcome);
    } catch (err) {
      if (!record_failed_message(tally, entry, target_folder_id, err)) break;
    }
    report_message_progress(progress, tally, entry);
    if (tally.refusal !== undefined) break;
  }

  return tally;
}

/** A tally with nothing restored yet. */
function empty_tally(): FolderRestoreTally {
  return {
    restored: 0,
    attachments: 0,
    errors: [],
    attachment_errors: [],
    messages: [],
    warnings: [],
    outcome_unknown: [],
  };
}

/** Adds a created message to the tally, with the attachments it is missing. */
function record_restored_message(
  tally: FolderRestoreTally,
  entry: ManifestEntry,
  target_folder_id: string,
  outcome: EntryRestoreOutcome,
): void {
  tally.restored++;
  tally.attachments += outcome.att;
  // The message landed, so this is not an entry failure, but the mailbox is missing content
  // the snapshot holds. Reporting it keeps the run out of a clean exit (issue #341).
  append_all(
    tally.attachment_errors,
    outcome.attachment_errors.map((e) => `${entry.object_id}: ${e}`),
  );
  append_all(
    tally.outcome_unknown,
    unknown_attachment_creates(
      entry.object_id,
      target_folder_id,
      outcome.attachment_outcome_unknown,
      `${entry.object_id}: `,
    ),
  );
  tally.messages.push(outcome.report);
  const shortfall = attachment_shortfall_warning(outcome.report);
  if (shortfall) tally.warnings.push(shortfall);
  if (outcome.refusal !== undefined) tally.refusal = outcome.refusal;
}

/**
 * Records a message that was not created. Returns false when the folder stops without reporting
 * progress for it: a create cut short by Ctrl+C is the run stopping, not a failed message (#682),
 * unless the create was sent and may have committed, which is named either way (issue #893).
 * A refusal for the whole mailbox would fail every later message the same way, so it is kept on
 * the tally to end the restore (issue #871).
 */
function record_failed_message(
  tally: FolderRestoreTally,
  entry: ManifestEntry,
  target_folder_id: string,
  err: unknown,
): boolean {
  const may_exist = err instanceof WriteOutcomeUnknownError;
  if (is_active_run_cancelled() && !may_exist) return false;
  if (is_run_fatal_error(err)) {
    tally.refusal = err;
    return false;
  }
  const line = `${entry.object_id}: ${err instanceof Error ? err.message : String(err)}`;
  tally.errors.push(line);
  const unknown = unknown_message_create(entry.object_id, target_folder_id, line, err);
  if (unknown !== undefined) tally.outcome_unknown.push(unknown);
  return !is_active_run_cancelled();
}

/** Updates the dashboard and emits the progress event after one message. */
function report_message_progress(
  progress: FolderProgress,
  tally: FolderRestoreTally,
  entry: ManifestEntry,
): void {
  const gp = progress.global_before + tally.restored;
  const rate = calc_rate(gp, Date.now() - progress.start);
  const eta = rate > 0 ? (progress.global_total - gp) / rate : 0;
  progress.dashboard.update_active(progress.folder_index, {
    transferred: tally.restored,
    attachments: tally.attachments,
    rate,
    eta_seconds: eta,
  });
  progress.dashboard.update_total(gp, progress.global_total, rate, eta);
  emit_operation_progress(progress.control, {
    operation: 'restore',
    workload: 'outlook',
    phase: 'processing',
    processed: gp,
    total: progress.global_total,
    current: entry.subject ?? entry.object_id,
    rate,
  });
}
