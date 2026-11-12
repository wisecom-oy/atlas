import type {
  MailboxConnector,
  Manifest,
  ManifestEntry,
  RestoreConnector,
  RestoreOptions,
  RestoreResult,
  TenantContext,
} from '@wisecom/atlas-types';
import {
  emit_operation_progress,
  finish_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
import { open_restore_root } from '@/services/restore/restore-destination';
import { restore_single_message } from '@/services/restore/restore-execution-orchestrator';

/** Everything one single-message restore needs: where it reads, what it restores, where it writes. */
export interface SingleMessageRestoreRun {
  readonly ctx: TenantContext;
  readonly connector: MailboxConnector;
  readonly restore_connector: RestoreConnector;
  readonly tenant_id: string;
  readonly source_mailbox: string;
  readonly target_mailbox: string;
  readonly snapshot_id: string;
  readonly entry: ManifestEntry;
  readonly manifests: readonly Manifest[];
  readonly options: RestoreOptions;
}

/** The result of a restore that restored nothing. */
export function empty_restore_result(snapshot_id: string, interrupted = false): RestoreResult {
  return {
    snapshot_id,
    restored_count: 0,
    attachment_count: 0,
    error_count: 0,
    attachment_error_count: 0,
    errors: [],
    verification_warnings: [],
    messages: [],
    restore_folder_name: '',
    interrupted,
  };
}

/** Restores the one message `message_ref` named, reporting progress as a run of one item. */
export async function restore_message_run(run: SingleMessageRestoreRun): Promise<RestoreResult> {
  const { options, entry } = run;
  if (options.should_interrupt?.() === true || options.abort_signal?.aborted === true) {
    emit_operation_progress(options, {
      operation: 'restore',
      workload: 'outlook',
      phase: 'interrupted',
      processed: 0,
      total: 1,
    });
    return empty_restore_result(run.snapshot_id, true);
  }
  emit_operation_progress(options, {
    operation: 'restore',
    workload: 'outlook',
    phase: 'processing',
    processed: 0,
    total: 1,
    current: entry.subject ?? entry.object_id,
  });
  const root = await open_restore_root(
    run.restore_connector,
    run.tenant_id,
    run.target_mailbox,
    options.destination,
  );
  const result = await restore_single_message(
    run.ctx,
    run.connector,
    root.connector,
    run.tenant_id,
    run.source_mailbox,
    run.target_mailbox,
    run.snapshot_id,
    entry,
    root.folder,
    run.manifests,
  );
  // The signal is read too: a caller that passes only `abort_signal` stopped the attachment
  // uploads of this message, and the run is interrupted though the message landed.
  const interrupted = finish_operation_progress(
    options,
    'restore',
    'outlook',
    1,
    1,
    was_aborted(options.abort_signal),
  );
  return { ...result, interrupted };
}

/**
 * Reads the signal at the moment of the call. A plain `signal.aborted` check after an earlier
 * early return is narrowed to false by the compiler, though the signal can fire in between.
 */
function was_aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
