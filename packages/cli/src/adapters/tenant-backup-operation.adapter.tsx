/**
 * CLI adapter that wires the Ink tenant dashboard + SIGINT handling
 * for the full-tenant backup command (`atlas backup` without `-m`).
 *
 * Intentionally unreachable since #166: `atlas outlook backup` requires `-m` and the
 * tenant fan-out handler is commented out. Kept for recovery together with the
 * tenant dashboard components; do not delete in a dead-code sweep.
 */

import type { Instance } from 'ink';
import type {
  TenantBackupOrchestrator,
  TenantBackupOptions,
  TenantBackupResult,
  TenantProgressReporter,
} from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core';
import { TenantBackupStore } from '@/ui/dashboards/tenant-backup-store';
import { TenantBackupLineReporter } from '@/ui/dashboards/tenant-backup-line-reporter';
import { TenantBackupView } from '@/ui/dashboards/tenant-backup';
import { ResultSummary } from '@/ui/components/result-summary';
import { mount_live_view, render_static_view } from '@/ui/render';

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

  let reporter: TenantProgressReporter;
  let instance: Instance | undefined;
  if (process.stdout.isTTY) {
    const store = new TenantBackupStore(concurrency);
    instance = mount_live_view(<TenantBackupView store={store} />);
    reporter = store;
  } else {
    reporter = new TenantBackupLineReporter();
  }

  const on_sigint = (): void => {
    state.sigint_count++;
    state.interrupted = true;
    if (state.sigint_count === 1) {
      reporter.set_status(
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
      progress: reporter,
      should_interrupt: () => state.interrupted,
      should_force_stop: () => state.sigint_count >= 2,
    });

    instance?.unmount();
    instance = undefined;
    await log_tenant_result(result);
    return result;
  } finally {
    instance?.unmount();
    process.removeListener('SIGINT', on_sigint);
  }
}

async function log_tenant_result(result: TenantBackupResult): Promise<void> {
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
    `Tenant backup complete: ${result.succeeded} succeeded, ${result.failed} failed ` +
      `of ${result.total_mailboxes} mailbox(es) -- ${elapsed_s}s`,
  );

  await render_static_view(
    <ResultSummary
      entries={[
        { label: 'stored', value: total_stored, color: 'green' },
        { label: 'dedup', value: total_deduped, color: 'yellow' },
        { label: 'attachments', value: total_att, color: 'cyan' },
      ]}
    />,
  );

  if (result.interrupted) {
    logger.warn(`Interrupted -- ${result.succeeded}/${result.total_mailboxes} mailboxes completed`);
  }

  for (const outcome of result.outcomes) {
    if (outcome.error) {
      logger.error(`  ${outcome.owner_id}: ${outcome.error}`);
    }
  }
}
