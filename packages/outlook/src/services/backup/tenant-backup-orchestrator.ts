/**
 * Orchestrates parallel backup of all licensed and shared mailboxes in a tenant.
 * Unlicensed non-shared users are skipped -- Graph rejects their mail endpoints.
 * Shared mailboxes are detected via mailboxSettings.userPurpose during discovery.
 * CLI-only -- not wired into the SDK adapter.
 */

import { inject, injectable } from 'inversify';
import type {
  MailboxDiscoveryService,
  ManifestRepository,
  TenantContextFactory,
  TenantMailbox,
} from '@wisecom/atlas-types';
import type { BackupUseCase } from '@wisecom/atlas-types';
import type {
  TenantBackupOrchestrator as ITenantBackupOrchestrator,
  TenantBackupOptions,
  TenantBackupResult,
  MailboxBackupOutcome,
} from '@wisecom/atlas-types';
import {
  MAILBOX_DISCOVERY_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { BACKUP_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import { calc_rate } from '@wisecom/atlas-core/services/shared/progress-rate';
import { create_mailbox_progress_adapter } from '@/services/backup/tenant-backup-progress-adapter';

const DEFAULT_CONCURRENCY = 4;
const always_false = (): boolean => false;

@injectable()
export class DefaultTenantBackupOrchestrator implements ITenantBackupOrchestrator {
  constructor(
    @inject(MAILBOX_DISCOVERY_TOKEN) private readonly _discovery: MailboxDiscoveryService,
    @inject(BACKUP_USE_CASE_TOKEN) private readonly _backup: BackupUseCase,
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(MANIFEST_REPOSITORY_TOKEN) private readonly _manifests: ManifestRepository,
  ) {}

  async backup_tenant(
    tenant_id: string,
    options: TenantBackupOptions = {},
  ): Promise<TenantBackupResult> {
    const start = Date.now();
    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    const should_interrupt = options.should_interrupt ?? always_false;
    const should_force_stop = options.should_force_stop ?? always_false;
    const progress = options.progress;

    const all = await this._discovery.list_tenant_mailboxes(tenant_id);
    const mailboxes = all.filter(is_backed_up_by_tenant_run);
    const excluded = all.filter((m) => !is_backed_up_by_tenant_run(m));
    const shared_count = mailboxes.filter((m) => m.mailbox_purpose === 'shared').length;
    const lookup_failed_count = excluded.filter((m) => m.purpose_lookup_error).length;

    logger.info(
      `Discovered ${mailboxes.length} mailbox(es) for backup (${shared_count} shared, ` +
        `${excluded.length - lookup_failed_count} unlicensed non-shared skipped, ` +
        `${lookup_failed_count} skipped after a failed mailboxSettings lookup)`,
    );
    progress?.set_mailbox_count(mailboxes.length);

    const outcomes = await this.report_excluded_with_history(tenant_id, excluded);
    const excluded_count = outcomes.length;
    // TODO: resolve email -> object_id via UserIdentityResolver; pending queue should hold owner IDs for storage.
    const pending = mailboxes.map((m) => m.mail);
    let done_count = 0;
    let error_count = outcomes.length;
    let global_stored = 0;
    let global_deduped = 0;

    const run_worker = async (slot: number): Promise<void> => {
      while (pending.length > 0 && !should_interrupt()) {
        const mailbox_id = pending.shift()!;
        progress?.mark_mailbox_active(slot, mailbox_id);

        try {
          const result = await this._backup.sync_mailbox(tenant_id, mailbox_id, {
            force_full: options.force_full,
            page_size: options.page_size,
            object_lock_request: options.object_lock_request,
            object_lock_policy: options.object_lock_policy,
            should_interrupt,
            should_force_stop,
            create_progress: create_mailbox_progress_adapter(slot, progress),
          });

          global_stored += result.summary.stored;
          global_deduped += result.summary.deduplicated;
          done_count++;
          progress?.mark_mailbox_done(
            slot,
            mailbox_id,
            result.summary.stored,
            result.summary.deduplicated,
          );
          outcomes.push({ owner_id: mailbox_id, result });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          error_count++;
          progress?.mark_mailbox_error(slot, mailbox_id, msg);
          outcomes.push({ owner_id: mailbox_id, error: msg });
          logger.error(`Mailbox ${mailbox_id} failed: ${msg}`);
        }

        const elapsed = Date.now() - start;
        const rate = calc_rate(global_stored + global_deduped, elapsed);
        const eta =
          rate > 0
            ? (pending.length * (elapsed / Math.max(done_count + error_count, 1))) / 1000
            : 0;
        progress?.update_totals(done_count, error_count, pending.length, rate, eta);
      }
    };

    const worker_count = Math.min(concurrency, mailboxes.length);
    const workers: Promise<void>[] = [];
    for (let i = 0; i < worker_count; i++) {
      workers.push(run_worker(i));
    }
    await Promise.all(workers);

    progress?.finish();

    return {
      outcomes,
      total_mailboxes: mailboxes.length + excluded_count,
      succeeded: done_count,
      failed: error_count,
      interrupted: should_interrupt(),
      elapsed_ms: Date.now() - start,
    };
  }

  /**
   * Fails every excluded mailbox that already has backups, by address and reason. A mailbox that
   * drops out of selection (shared converted to user before licensing, or a failed userPurpose
   * lookup) would otherwise stop being backed up while the run reports success (issue #480).
   * Never-backed-up unlicensed users stay a quiet skip.
   */
  private async report_excluded_with_history(
    tenant_id: string,
    excluded: TenantMailbox[],
  ): Promise<MailboxBackupOutcome[]> {
    if (excluded.length === 0) return [];
    const ctx = await this._tenant_factory.create_storage_only(tenant_id);
    const with_history = new Set(await this._manifests.list_owner_ids(ctx));
    return excluded
      .filter((m) => with_history.has(normalize_owner_id(m.mail)))
      .map((m) => {
        const error = `excluded from tenant backup but has existing backups: ${exclusion_reason(m)}`;
        logger.error(`Mailbox ${m.mail} ${error}`);
        return { owner_id: m.mail, error };
      });
  }
}

/** Graph serves mail for licensed users and shared mailboxes; anything else is rejected. */
function is_backed_up_by_tenant_run(m: TenantMailbox): boolean {
  return m.has_exchange_license || m.mailbox_purpose === 'shared';
}

function exclusion_reason(m: TenantMailbox): string {
  if (m.purpose_lookup_error) {
    return `mailboxSettings lookup failed (${m.purpose_lookup_error}), so a shared mailbox could not be detected`;
  }
  return 'no Exchange Online license and not a shared mailbox';
}
