// Deliberately not shared with the OneDrive copy (#306): 306 differing lines of 604. SharePoint
// walks a site tree, then libraries within it; OneDrive enumerates an owner's drives and
// carries a folder scope and a per-drive delta cursor. Unifying them means a parameter per
// branch, which is the shape that made the copies hard to change.
import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import { with_summary_unreadable_keys } from '@wisecom/atlas-core/services/shared/unreadable-object-report';
import { attach_run_retention } from '@wisecom/atlas-core/services/shared/run-object-lock';
import { run_cancellable } from '@wisecom/atlas-core/services/shared/cancellable-run';
import { randomBytes } from 'node:crypto';
import {
  begin_operation_progress,
  emit_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
import { inject, injectable } from 'inversify';
import { classify_empty_run } from '@wisecom/atlas-drive/backup/empty-run-classifier';
import { append_recrawl_tombstones } from '@wisecom/atlas-drive/backup/recrawl-tombstones';
import { merge_damaged_manifest_keys } from '@wisecom/atlas-drive/backup/damaged-manifest-report';
import { build_tracking_state } from '@/services/backup/file-tracking-state';
import {
  resolve_saved_cursor_binding,
  select_resumable_cursor,
} from '@wisecom/atlas-drive/shared/cursor-snapshot-binding';
import { SHAREPOINT_KEYS } from '@/services/shared/storage-keys';
import { build_version_errors } from '@wisecom/atlas-drive/backup/version-failure-errors';
import type {
  HeldOwnerLease,
  OwnerLeasePort,
  SharePointBackupOptions,
  SharePointBackupResult,
  SharePointBackupUseCase,
  SharePointSiteConnector,
  SharePointDeltaCursor,
  SharePointDeltaCursorRepository,
  SharePointFileVersionIndexRepository,
  SharePointManifestRepository,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  OWNER_LEASE_TOKEN,
  SHAREPOINT_CONNECTOR_TOKEN,
  SHAREPOINT_DELTA_CURSOR_REPOSITORY_TOKEN,
  SHAREPOINT_FILE_VERSION_INDEX_REPOSITORY_TOKEN,
  SHAREPOINT_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { describe_failed_items } from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import { logger } from '@wisecom/atlas-core/utils/logger';
import {
  build_delta_cursor,
  build_empty_result,
  build_package_warnings,
  build_run_version_indexes,
  build_snapshot_manifest,
  persist_snapshot_backup,
} from '@/services/backup/backup-builders';
import { load_run_version_collector } from '@/services/versioning/run-version-collector';
import {
  scan_all_libraries,
  type SharePointLibraryScanResult,
} from '@/services/backup/backup-library-scan';
import { cleanup_stale_staging } from '@/services/backup/large-file-pipeline';
import { interrupted_before_scan } from '@/services/backup/interrupted-scan-result';

@injectable()
export class SharePointBackupService implements SharePointBackupUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(SHAREPOINT_CONNECTOR_TOKEN) private readonly _connector: SharePointSiteConnector,
    @inject(SHAREPOINT_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: SharePointManifestRepository,
    @inject(SHAREPOINT_FILE_VERSION_INDEX_REPOSITORY_TOKEN)
    private readonly _file_indexes: SharePointFileVersionIndexRepository,
    @inject(SHAREPOINT_DELTA_CURSOR_REPOSITORY_TOKEN)
    private readonly _cursors: SharePointDeltaCursorRepository,
    @inject(OWNER_LEASE_TOKEN) private readonly _leases: OwnerLeasePort,
  ) {}

  /**
   * Backs up changed SharePoint files and creates a snapshot only when data changed.
   *
   * The run's abort signal is published to every Graph call inside it, so cancelling also ends a
   * Graph retry or throttle wait rather than only the next file (issue #673).
   *
   * The run holds the site's lease from before it reads the cursor until it ends.
   *
   * @throws OwnerBusyError when another operation holds the site's backup.
   */
  async backup_site(
    tenant_id: string,
    site_id: string,
    options: SharePointBackupOptions = {},
  ): Promise<SharePointBackupResult> {
    site_id = normalize_owner_id(site_id);
    const cancelled = (): SharePointBackupResult => interrupted_before_scan(site_id, options);
    if (begin_operation_progress(options, 'backup', 'sharepoint')) return cancelled();
    return run_cancellable(options, () => this.run_backup(tenant_id, site_id, options), cancelled);
  }

  private async run_backup(
    tenant_id: string,
    site_id: string,
    options: SharePointBackupOptions,
  ): Promise<SharePointBackupResult> {
    const tenant_ctx = await this._tenant_factory.create(tenant_id);
    let lease: HeldOwnerLease | undefined;
    try {
      // Taken before the cursor is read, released in the `finally` below (issue #623).
      lease = await this._leases.acquire(tenant_ctx, {
        workload: 'sharepoint',
        owner_id: site_id,
        operation: 'backup',
      });
      // Per-object retention carried by this run's context, not the bucket default: concurrent
      // runs on one tenant would overwrite each other's bucket setting (#551).
      const ctx = await attach_run_retention(tenant_ctx, options.object_lock_request);
      const stored_cursor = await this._cursors.load(ctx, site_id);
      // Read before this run saves a manifest, which would become the head and hide a damaged one.
      const head = await this._manifests.find_latest_readable(ctx, site_id);
      // A cursor whose snapshot is gone reads in full, as `--full` does: it would otherwise resume
      // past changes no snapshot holds (issue #725).
      const resume = await select_resumable_cursor(ctx, SHAREPOINT_KEYS, site_id, stored_cursor, {
        unit: 'library',
        force_full: options.force_full === true,
      });
      const previous_cursor = resume.previous_cursor;
      const libraries = await this._connector.list_document_libraries(tenant_id, site_id);
      // Same reasoning as the OneDrive twin: a revoked grant is a 403 that
      // `list_document_libraries` has already named, so an empty list is a site with no document
      // library rather than a permission fault (issue #369).
      if (libraries.length === 0) {
        logger.warn(`Site ${site_id} has no document libraries; there is nothing to back up`);
      }
      emit_operation_progress(options, {
        operation: 'backup',
        workload: 'sharepoint',
        phase: 'processing',
        processed: 0,
      });

      const delta_link_by_drive: Record<string, string> = {
        ...(previous_cursor?.delta_link_by_drive ?? {}),
      };
      const tracking = build_tracking_state(previous_cursor);

      await cleanup_stale_staging(ctx, site_id);

      const manifest_created_at = new Date();
      const snapshot_id = `sp-snap-${manifest_created_at.getTime()}-${randomBytes(3).toString('hex')}`;
      // Watermarks are read from the cursor even on a forced full run: they
      // record which historical versions Graph already handed over, not where
      // the delta stream stopped, and discarding them would re-download every
      // version of every file (issue #161).
      const versions = await load_run_version_collector(
        this._file_indexes,
        ctx,
        site_id,
        resume.watermark_cursor,
      );
      const scan = await scan_all_libraries({
        connector: this._connector,
        versions,
        initial_failed_items: previous_cursor?.failed_items ?? {},
        tenant_id,
        site_id,
        snapshot_id,
        libraries,
        options,
        previous_cursor,
        tracking,
        delta_link_by_drive,
        ctx,
      });
      const skipped_manifests = await append_recrawl_tombstones(scan, () =>
        this._manifests.list_readable_snapshots_by_site(ctx, site_id),
      );

      emit_operation_progress(options, {
        operation: 'backup',
        workload: 'sharepoint',
        phase: 'finalizing',
        processed: scan.items_processed,
      });
      scan.interrupted ||= options.should_interrupt?.() === true;
      const cursor = build_delta_cursor(
        site_id,
        delta_link_by_drive,
        tracking,
        scan.failed_items,
        versions.watermarks,
        // The snapshot this run writes, or the one it leaves as the newest when nothing changed.
        await resolve_saved_cursor_binding(
          scan.entries.length > 0 ? snapshot_id : undefined,
          previous_cursor,
          async () => head,
        ),
      );
      const warnings = [
        ...(resume.outlived_warning === undefined ? [] : [resume.outlived_warning]),
        ...build_package_warnings(scan.package_reports),
        ...describe_failed_items(scan.failed_items),
      ];
      // Version downloads that failed for an unexpected reason leave history out
      // of the snapshot: an error, not a warning, so the run exits EXIT_PARTIAL
      // like every other incomplete backup (issue #92).
      const errors = [
        ...scan.errors,
        ...build_version_errors(scan.version_stats.total_versions_failed),
      ];
      const healthy =
        !scan.interrupted && errors.length === 0 && Object.keys(scan.failed_items).length === 0;

      let result: SharePointBackupResult;
      if (scan.entries.length === 0) {
        // Versions captured before the run lost its entries (a library-level
        // failure discards them) are still on the wire and still watermarked:
        // the rows have to land before the cursor that tells the next run to
        // skip those versions, or that history is unreachable forever.
        lease.assert_held();
        await this._file_indexes.write_run_index(
          ctx,
          site_id,
          snapshot_id,
          build_run_version_indexes(site_id, snapshot_id, [], scan.version_rows),
        );
        lease.assert_held();
        await this._cursors.save(ctx, cursor);
        result = build_empty_result(
          site_id,
          scan.libraries_scanned,
          scan.files_stored,
          scan.files_deduplicated,
          scan.deleted_items,
          scan.version_stats.total_versions_stored,
          scan.version_stats.total_versions_unavailable,
          errors,
          warnings,
          healthy,
          scan.interrupted,
          true, // cursor_updated: the cursor was saved just above
          // `healthy`, not just `!interrupted`: a failed item still counts as processed, so a run
          // whose every file failed would otherwise read as `no_changes` when the truth is that
          // the changes did not land. An unhealthy run's reason is its errors.
          healthy
            ? await classify_empty_run({
                previous_kind_by_file_id: tracking.previous_kind_by_file_id,
                files_processed: scan.files_processed,
                find_latest_snapshot: async () => head,
              })
            : undefined,
        );
      } else {
        result = await this.finalize_snapshot(
          ctx,
          lease,
          tenant_id,
          site_id,
          scan,
          snapshot_id,
          manifest_created_at,
          scan.libraries_scanned,
          options,
          cursor,
          errors,
          warnings,
          healthy,
        );
      }
      emit_operation_progress(options, {
        operation: 'backup',
        workload: 'sharepoint',
        phase: scan.interrupted ? 'interrupted' : 'completed',
        processed: scan.items_processed,
      });
      return with_summary_unreadable_keys(
        result,
        merge_damaged_manifest_keys(head.unreadable_keys, skipped_manifests),
      );
    } finally {
      await lease?.release();
      tenant_ctx.destroy();
    }
  }

  private async finalize_snapshot(
    ctx: Awaited<ReturnType<TenantContextFactory['create']>>,
    lease: HeldOwnerLease,
    tenant_id: string,
    site_id: string,
    scan: SharePointLibraryScanResult,
    snapshot_id: string,
    manifest_created_at: Date,
    libraries_scanned: number,
    options: SharePointBackupOptions,
    cursor: SharePointDeltaCursor,
    errors: string[],
    warnings: string[],
    healthy: boolean,
  ): Promise<SharePointBackupResult> {
    const snapshot = build_snapshot_manifest(
      tenant_id,
      site_id,
      scan.entries,
      snapshot_id,
      manifest_created_at,
      options.site_url,
      options.site_display_name,
    );
    await persist_snapshot_backup(
      this._manifests,
      this._file_indexes,
      this._cursors,
      ctx,
      lease,
      site_id,
      snapshot,
      scan.entries,
      cursor,
      scan.version_rows,
    );

    return {
      site_id,
      snapshot,
      interrupted: scan.interrupted,
      summary: {
        libraries_scanned,
        files_changed: scan.entries.length,
        files_stored: scan.files_stored,
        files_deduplicated: scan.files_deduplicated,
        deleted_items: scan.deleted_items,
        cursor_updated: true,
        snapshot_created: true,
        versions_stored: scan.version_stats.total_versions_stored,
        versions_unavailable: scan.version_stats.total_versions_unavailable,
        errors,
        warnings,
        healthy,
      },
    };
  }
}
