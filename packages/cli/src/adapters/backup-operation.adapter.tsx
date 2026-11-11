import type { Instance } from 'ink';
import type {
  BackupProgressReporter,
  BackupUseCase,
  SyncOptions,
  SyncResult,
} from '@wisecom/atlas-types/ports/backup/use-case.port';
import { logger } from '@wisecom/atlas-core';
import type { InterruptGate } from '@/adapters/interrupt-gate';
import { BackupProgressStore } from '@/ui/dashboards/backup-progress-store';
import { BackupProgressLineReporter } from '@/ui/dashboards/backup-progress-line-reporter';
import { BackupProgressView } from '@/ui/dashboards/backup-progress';
import { ResultSummary } from '@/ui/components/result-summary';
import { mount_live_view, render_static_view } from '@/ui/render';

/** Shown on the dashboard after the first Ctrl+C; the gate logs the same line. */
export const OUTLOOK_INTERRUPT_MESSAGE =
  '[!] Stopping; folders already finished keep their delta state (Ctrl+C again to force quit)';

/**
 * Executes the backup use case with an Ink progress dashboard, stopping on the gate's Ctrl+C.
 *
 * The gate's signal is passed as `abort_signal`, so the first Ctrl+C also ends a Graph retry or
 * throttle wait. The gate exits with 130 on the second, which the old listener here never did: it
 * only set a flag polled at page boundaries, so no number of presses ended a run parked in a wait
 * (issue #673).
 */
export async function run_backup_with_cli_adapter(
  use_case: BackupUseCase,
  tenant_id: string,
  mailbox_id: string,
  options: SyncOptions,
  gate: InterruptGate,
): Promise<SyncResult> {
  let reporter: BackupProgressReporter | undefined;
  let instance: Instance | undefined;

  const show_stopping = (): void => reporter?.set_status(OUTLOOK_INTERRUPT_MESSAGE);
  gate.abort_signal.addEventListener('abort', show_stopping, { once: true });
  try {
    const result = await use_case.sync_mailbox(tenant_id, mailbox_id, {
      ...options,
      create_progress: (folders) => {
        if (process.stdout.isTTY) {
          const store = new BackupProgressStore(folders);
          instance = mount_live_view(<BackupProgressView store={store} />);
          reporter = store;
          return store;
        }
        const line_reporter = new BackupProgressLineReporter(folders);
        reporter = line_reporter;
        return line_reporter;
      },
      should_interrupt: gate.should_interrupt,
      abort_signal: gate.abort_signal,
    });

    instance?.unmount();
    instance = undefined;
    await log_backup_result(result);
    return result;
  } finally {
    instance?.unmount();
    gate.abort_signal.removeEventListener('abort', show_stopping);
  }
}

/**
 * Logs the sync mode, warnings, counters, and interruption. A run cancelled before it read any
 * folder stored nothing, so it gets neither the mode line nor counters, only the interruption.
 */
async function log_backup_result(result: SyncResult): Promise<void> {
  if (result.snapshot_stored === false) {
    logger.warn(
      'Interrupted before any folder was read. Nothing was backed up and no snapshot was saved.',
    );
    return;
  }
  log_sync_mode(result);

  for (const warning of result.summary.warnings) {
    logger.warn(warning);
  }
  for (const folder_error of result.summary.folder_errors) {
    logger.warn(folder_error);
  }

  const elapsed_s = (result.summary.elapsed_ms / 1000).toFixed(1);
  await render_static_view(
    <ResultSummary
      entries={[
        { label: 'stored', value: result.summary.stored, color: 'green' },
        { label: 'dedup', value: result.summary.deduplicated, color: 'yellow' },
        { label: 'attachments', value: result.summary.attachments_stored, color: 'cyan' },
        { label: 'errors', value: result.summary.folder_errors.length, color: 'red' },
      ]}
      suffix={`${elapsed_s}s`}
    />,
  );

  if (result.summary.interrupted) {
    logger.warn(
      `Interrupted -- progress saved (${result.summary.completed_folder_count}/` +
        `${result.summary.total_folder_count} folders, ${result.summary.processed} items)`,
    );
  }
}

function log_sync_mode(result: SyncResult): void {
  if (result.mode === 'full') {
    logger.info('Full sync forced – ignoring saved delta state');
  } else if (result.mode === 'incremental') {
    logger.info('Resuming incremental sync from saved delta state');
  } else {
    logger.info('No prior backup found – running initial full sync');
  }
}
