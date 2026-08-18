import type { Instance } from 'ink';
import type {
  BackupProgressReporter,
  BackupUseCase,
  SyncOptions,
  SyncResult,
} from '@wisecom/atlas-types/ports/backup/use-case.port';
import { logger } from '@wisecom/atlas-core';
import { BackupProgressStore } from '@/ui/dashboards/backup-progress-store';
import { BackupProgressLineReporter } from '@/ui/dashboards/backup-progress-line-reporter';
import { BackupProgressView } from '@/ui/dashboards/backup-progress';
import { ResultSummary } from '@/ui/components/result-summary';
import { mount_live_view, render_static_view } from '@/ui/render';

interface InterruptState {
  interrupted: boolean;
  sigint_count: number;
}

/** Executes backup use case with an Ink progress dashboard and SIGINT behavior. */
export async function run_backup_with_cli_adapter(
  use_case: BackupUseCase,
  tenant_id: string,
  mailbox_id: string,
  options: SyncOptions,
): Promise<SyncResult> {
  const state: InterruptState = { interrupted: false, sigint_count: 0 };
  let reporter: BackupProgressReporter | undefined;
  let instance: Instance | undefined;

  const on_sigint = (): void => {
    state.sigint_count++;
    state.interrupted = true;
    if (state.sigint_count === 1) {
      reporter?.set_status(
        '[!] Stopping -- finishing page fetch to save delta state (Ctrl+C again to force quit)',
      );
    }
  };

  process.on('SIGINT', on_sigint);
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
      should_interrupt: () => state.interrupted,
      should_force_stop: () => state.sigint_count >= 2,
    });

    instance?.unmount();
    instance = undefined;
    await log_backup_result(result);
    return result;
  } finally {
    instance?.unmount();
    process.removeListener('SIGINT', on_sigint);
  }
}

async function log_backup_result(result: SyncResult): Promise<void> {
  if (result.mode === 'full') {
    logger.info('Full sync forced – ignoring saved delta state');
  } else if (result.mode === 'incremental') {
    logger.info('Resuming incremental sync from saved delta state');
  } else {
    logger.info('No prior backup found – running initial full sync');
  }

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
