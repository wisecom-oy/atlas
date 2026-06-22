import chalk from 'chalk';
import type {
  BackupUseCase,
  SyncOptions,
  SyncResult,
} from '@atlas/types/ports/backup/use-case.port';
import { BackupProgressDashboard } from '@atlas/outlook';
import { logger } from '@atlas/core';

interface InterruptState {
  interrupted: boolean;
  sigint_count: number;
}

/** Executes backup use case with CLI progress dashboard and SIGINT behavior. */
export async function run_backup_with_cli_adapter(
  use_case: BackupUseCase,
  tenant_id: string,
  mailbox_id: string,
  options: SyncOptions,
): Promise<SyncResult> {
  const state: InterruptState = { interrupted: false, sigint_count: 0 };
  let dashboard: BackupProgressDashboard | undefined;

  const on_sigint = (): void => {
    state.sigint_count++;
    state.interrupted = true;
    if (state.sigint_count === 1) {
      dashboard?.set_status(
        '[!] Stopping -- finishing page fetch to save delta state (Ctrl+C again to force quit)',
      );
    }
  };

  process.on('SIGINT', on_sigint);
  try {
    const result = await use_case.sync_mailbox(tenant_id, mailbox_id, {
      ...options,
      create_progress: (folders) => {
        dashboard = new BackupProgressDashboard(folders);
        return dashboard;
      },
      should_interrupt: () => state.interrupted,
      should_force_stop: () => state.sigint_count >= 2,
    });
    log_backup_result(result);
    return result;
  } finally {
    process.removeListener('SIGINT', on_sigint);
  }
}

function log_backup_result(result: SyncResult): void {
  if (result.mode === 'full') {
    logger.info(chalk.yellow('Full sync forced – ignoring saved delta state'));
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
  logger.info(
    `${chalk.green(String(result.summary.stored))} stored, ` +
      `${chalk.yellow(String(result.summary.deduplicated))} dedup, ` +
      `${chalk.cyan(String(result.summary.attachments_stored))} attachments, ` +
      `${chalk.red(String(result.summary.folder_errors.length))} errors -- ${elapsed_s}s`,
  );

  if (result.summary.interrupted) {
    logger.warn(
      chalk.yellow(
        `Interrupted -- progress saved (${result.summary.completed_folder_count}/` +
          `${result.summary.total_folder_count} folders, ${result.summary.processed} items)`,
      ),
    );
  }
}
