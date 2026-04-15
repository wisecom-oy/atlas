import { inject, injectable } from 'inversify';
import chalk from 'chalk';
import type { TenantContextFactory, TenantContext } from '@/ports/tenant/context.port';
import type { ManifestRepository } from '@/ports/storage/manifest-repository.port';
import type { MailboxConnector } from '@/ports/mailbox/connector.port';
import type { RestoreConnector } from '@/ports/restore/connector.port';
import type { Manifest, ManifestEntry } from '@/domain/manifest';
import {
  build_folder_map,
  filter_entries_by_folder_name,
} from '@/services/restore/folder-restore-planner';
import {
  load_mailbox_manifests,
  merge_snapshot_entries,
} from '@/services/restore/manifest-entry-merger';
import {
  restore_single_message,
  backfill_missing_folder_ids,
} from '@/services/restore/restore-execution-orchestrator';
import { run_restore_batch } from '@/services/restore/restore-batch-runner';
import { assert_mailbox_exists } from '@/services/shared/mailbox-assertions';
import { logger } from '@/utils/logger';
import type { RestoreUseCase, RestoreResult, RestoreOptions } from '@/ports/restore/use-case.port';
import {
  TENANT_CONTEXT_FACTORY_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  MAILBOX_CONNECTOR_TOKEN,
  RESTORE_CONNECTOR_TOKEN,
} from '@/ports/tokens/outgoing.tokens';

const EMPTY_RESULT: Omit<RestoreResult, 'snapshot_id'> = {
  restored_count: 0,
  attachment_count: 0,
  error_count: 0,
  attachment_error_count: 0,
  verification_failures: 0,
  errors: [],
  attachment_errors: [],
  verification_warnings: [],
  restore_folder_name: '',
};

@injectable()
export class RestoreService implements RestoreUseCase {
  private _interrupted = false;

  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(MANIFEST_REPOSITORY_TOKEN) private readonly _manifests: ManifestRepository,
    @inject(MAILBOX_CONNECTOR_TOKEN) private readonly _connector: MailboxConnector,
    @inject(RESTORE_CONNECTOR_TOKEN) private readonly _restore_connector: RestoreConnector,
  ) {}

  /**
   * Restores messages from a snapshot back to the mailbox via Graph API.
   * Supports full snapshot, single folder, or single message scope.
   */
  async restore_snapshot(
    tenant_id: string,
    snapshot_id: string,
    options: RestoreOptions = {},
  ): Promise<RestoreResult> {
    const ctx = await this._tenant_factory.create(tenant_id);
    try {
      const manifest = await this.load_manifest(ctx, snapshot_id);
      const source_mailbox = manifest.mailbox_id;
      const target_mailbox = options.target_mailbox?.toLowerCase() ?? source_mailbox;

      await assert_mailbox_exists(this._connector, tenant_id, target_mailbox);

      const entries = await this.resolve_entries(ctx, manifest, source_mailbox, tenant_id, options);
      if (entries.length === 0) {
        logger.warn('No entries to restore');
        return { snapshot_id, ...EMPTY_RESULT };
      }

      if (options.message_ref) {
        return await restore_single_message(
          ctx,
          this._connector,
          this._restore_connector,
          tenant_id,
          source_mailbox,
          target_mailbox,
          snapshot_id,
          entries[0]!,
        );
      }

      return await this.dispatch_batch(
        ctx,
        tenant_id,
        source_mailbox,
        target_mailbox,
        snapshot_id,
        entries,
      );
    } finally {
      ctx.destroy();
    }
  }

  /**
   * Restores messages from all snapshots for a mailbox, merging and
   * deduplicating entries. Supports date range filtering and folder filter.
   */
  async restore_mailbox(
    tenant_id: string,
    mailbox_id: string,
    options: RestoreOptions = {},
  ): Promise<RestoreResult> {
    const ctx = await this._tenant_factory.create(tenant_id);
    try {
      const target = options.target_mailbox?.toLowerCase() ?? mailbox_id;
      await assert_mailbox_exists(this._connector, tenant_id, target);

      const manifests = await load_mailbox_manifests(
        this._manifests,
        ctx,
        mailbox_id,
        options.start_date,
        options.end_date,
      );
      if (manifests.length === 0) {
        logger.warn('No snapshots found for this mailbox in the given date range');
        return { snapshot_id: 'mailbox', ...EMPTY_RESULT };
      }

      const entries = merge_snapshot_entries(manifests);
      const filtered = await this.apply_folder_filter(ctx, entries, mailbox_id, tenant_id, options);

      if (filtered.length === 0) {
        logger.warn('No entries to restore after filtering');
        return { snapshot_id: 'mailbox', ...EMPTY_RESULT };
      }

      logger.info(
        `Aggregated ${chalk.cyan(String(manifests.length))} snapshots -- ` +
          `${chalk.cyan(String(filtered.length))} unique messages`,
      );

      return await this.dispatch_batch(ctx, tenant_id, mailbox_id, target, 'mailbox', filtered);
    } finally {
      ctx.destroy();
    }
  }

  private async load_manifest(ctx: TenantContext, snapshot_id: string): Promise<Manifest> {
    const manifest = await this._manifests.find_by_snapshot(ctx, snapshot_id);
    if (!manifest) throw new Error(`No manifest found for snapshot ${snapshot_id}`);
    return manifest;
  }

  private async resolve_entries(
    ctx: TenantContext,
    manifest: Manifest,
    mailbox_id: string,
    tenant_id: string,
    options: RestoreOptions,
  ): Promise<ManifestEntry[]> {
    if (options.message_ref) {
      const entry = resolve_single_entry(manifest, options.message_ref);
      return entry ? [entry] : [];
    }

    if (options.folder_name) {
      await backfill_missing_folder_ids(ctx, manifest.entries);
      const folder_map = await build_folder_map(this._connector, tenant_id, mailbox_id);
      return filter_entries_by_folder_name(manifest.entries, options.folder_name, folder_map);
    }

    return manifest.entries;
  }

  private async apply_folder_filter(
    ctx: TenantContext,
    entries: ManifestEntry[],
    mailbox_id: string,
    tenant_id: string,
    options: RestoreOptions,
  ): Promise<ManifestEntry[]> {
    if (!options.folder_name) return entries;
    await backfill_missing_folder_ids(ctx, entries);
    const folder_map = await build_folder_map(this._connector, tenant_id, mailbox_id);
    return filter_entries_by_folder_name(entries, options.folder_name, folder_map);
  }

  private async dispatch_batch(
    ctx: TenantContext,
    tenant_id: string,
    source_mailbox: string,
    target_mailbox: string,
    snapshot_id: string,
    entries: ManifestEntry[],
  ): Promise<RestoreResult> {
    this._interrupted = false;
    const on_sigint = (): void => {
      this._interrupted = true;
    };
    process.on('SIGINT', on_sigint);
    try {
      return await run_restore_batch({
        ctx,
        connector: this._connector,
        restore_connector: this._restore_connector,
        tenant_id,
        source_mailbox,
        target_mailbox,
        snapshot_id,
        entries,
        is_interrupted: () => this._interrupted,
      });
    } finally {
      process.removeListener('SIGINT', on_sigint);
    }
  }
}

function resolve_single_entry(manifest: Manifest, ref: string): ManifestEntry | undefined {
  const index = Number(ref);
  if (Number.isInteger(index) && index >= 1) return manifest.entries[index - 1];
  return manifest.entries.find((e) => e.object_id === ref);
}
