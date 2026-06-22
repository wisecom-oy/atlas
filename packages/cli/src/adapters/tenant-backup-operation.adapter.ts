/**
 * CLI adapter that wires TenantBackupDashboard + SIGINT handling
 * for the full-tenant backup command (`atlas backup` without `-m`).
 */

import chalk from 'chalk';
import type {
  TenantBackupOrchestrator,
  TenantBackupOptions,
  TenantBackupResult,
} from '@wisecom/atlas-types';
import { TenantBackupDashboard } from '@wisecom/atlas-outlook';
import { logger } from '@wisecom/atlas-core';

interface TenantInterruptState {
  interrupted: boolean;
  sigint_count: number;
}

/** Runs full-tenant backup with dashboard progress and SIGINT handling. */
export async function run_tenant_backup_with_cli_adapter(
  orchestrator: TenantBackupOrchestrator,
  tenant_id: string,
  options: Omit<TenantBackupOptions, 'progress' | 'should_interrupt' | 'should_force_stop'>,
): Promise<TenantBackupResult> {
  const state: TenantInterruptState = { interrupted: false, sigint_count: 0 };
  const concurrency = options.concurrency ?? 4;
  const dashboard = new TenantBackupDashboard(concurrency);

  const on_sigint = (): void => {
    state.sigint_count++;
    state.interrupted = true;
    if (state.sigint_count === 1) {
      dashboard.set_status(
        '[!] Stopping -- finishing active mailboxes (Ctrl+C again to force quit)',
      );
    } else {
      process.exit(1);
    }
  };

  process.on('SIGINT', on_sigint);
  try {
    const result = await orchestrator.backup_tenant(tenant_id, {
      ...options,
      progress: dashboard,
      should_interrupt: () => state.interrupted,
      should_force_stop: () => state.sigint_count >= 2,
    });

    log_tenant_result(result);
    return result;
  } finally {
    process.removeListener('SIGINT', on_sigint);
  }
}

function log_tenant_result(result: TenantBackupResult): void {
  const elapsed_s = (result.elapsed_ms / 1000).toFixed(1);
  const total_stored = result.outcomes.reduce((sum, o) => sum + (o.result?.summary.stored ?? 0), 0);
  const total_deduped = result.outcomes.reduce(
    (sum, o) => sum + (o.result?.summary.deduplicated ?? 0),
    0,
  );
  const total_att = result.outcomes.reduce(
    (sum, o) => sum + (o.result?.summary.attachments_stored ?? 0),
    0,
  );

  logger.info(
    `\nTenant backup complete: ` +
      `${chalk.green(String(result.succeeded))} succeeded, ` +
      `${chalk.red(String(result.failed))} failed ` +
      `of ${result.total_mailboxes} mailbox(es) -- ${elapsed_s}s`,
  );

  logger.info(
    `${chalk.green(String(total_stored))} stored, ` +
      `${chalk.yellow(String(total_deduped))} dedup, ` +
      `${chalk.cyan(String(total_att))} attachments`,
  );

  if (result.interrupted) {
    logger.warn(
      chalk.yellow(
        `Interrupted -- ${result.succeeded}/${result.total_mailboxes} mailboxes completed`,
      ),
    );
  }

  for (const outcome of result.outcomes) {
    if (outcome.error) {
      logger.error(`  ${outcome.owner_id}: ${outcome.error}`);
    }
  }
}
