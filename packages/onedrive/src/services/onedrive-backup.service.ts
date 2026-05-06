import { createHash, randomBytes } from 'node:crypto';
import { inject, injectable } from 'inversify';
import type {
  OneDriveBackupOptions,
  OneDriveBackupResult,
  OneDriveBackupUseCase,
  OneDriveConnector,
  OneDriveDeltaCursor,
  OneDriveDeltaCursorRepository,
  OneDriveDeltaItem,
  OneDriveFileVersionIndexRepository,
  OneDriveManifestEntry,
  OneDriveManifestRepository,
  TenantContext,
  TenantContextFactory,
} from '@atlas/types';
import {
  ONEDRIVE_CONNECTOR_TOKEN,
  ONEDRIVE_DELTA_CURSOR_REPOSITORY_TOKEN,
  ONEDRIVE_FILE_INDEX_REPOSITORY_TOKEN,
  ONEDRIVE_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@atlas/types';
import { logger } from '@atlas/core/utils/logger';
import {
  accumulate_version_stats,
  build_deleted_entry,
  build_empty_result,
  build_snapshot_manifest,
  build_stored_entry,
} from '@/services/onedrive-backup-builders';
import { classify_change_type } from '@/services/onedrive-change-classifier';
import { download_with_retry } from '@/services/onedrive-download-orchestrator';
import {
  cleanup_stale_staging,
  LARGE_FILE_THRESHOLD,
  process_large_file,
} from '@/services/onedrive-large-file-pipeline';
import { onedrive_data_key } from '@/services/onedrive-storage-keys';
import { sync_file_versions } from '@/services/onedrive-version-sync';

const HASH_CHUNK_SIZE = 64 * 1024 * 1024;

@injectable()
export class OneDriveBackupService implements OneDriveBackupUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(ONEDRIVE_CONNECTOR_TOKEN) private readonly _connector: OneDriveConnector,
    @inject(ONEDRIVE_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: OneDriveManifestRepository,
    @inject(ONEDRIVE_FILE_INDEX_REPOSITORY_TOKEN)
    private readonly _file_indexes: OneDriveFileVersionIndexRepository,
    @inject(ONEDRIVE_DELTA_CURSOR_REPOSITORY_TOKEN)
    private readonly _cursors: OneDriveDeltaCursorRepository,
  ) {}

  /** Backs up changed OneDrive files and creates a snapshot only when data changed. */
  async backup_onedrive(
    tenant_id: string,
    owner_id: string,
    options: OneDriveBackupOptions = {},
  ): Promise<OneDriveBackupResult> {
    const ctx = await this._tenant_factory.create(tenant_id);
    const previous_cursor =
      options.force_full === true ? undefined : await this._cursors.load(ctx, owner_id);
    const drives = await this._connector.list_drives(tenant_id, owner_id);
    ensure_drives_discovered(drives.length);

    const delta_link_by_drive: Record<string, string> = {
      ...(previous_cursor?.delta_link_by_drive ?? {}),
    };
    const previous_path_by_file_id: Record<string, string> = {
      ...(previous_cursor?.previous_path_by_file_id ?? {}),
    };
    const previous_name_by_file_id: Record<string, string> = {
      ...(previous_cursor?.previous_name_by_file_id ?? {}),
    };
    const previous_etag_by_file_id: Record<string, string> = {
      ...(previous_cursor?.previous_etag_by_file_id ?? {}),
    };

    await cleanup_stale_staging(ctx, owner_id);

    const manifest_created_at = new Date();
    const snapshot_id = `od-snap-${manifest_created_at.getTime()}-${randomBytes(3).toString('hex')}`;

    const entries: OneDriveManifestEntry[] = [];
    let files_stored = 0;
    let files_deduplicated = 0;
    let deleted_items = 0;
    let total_versions_stored = 0;
    let total_versions_unavailable = 0;
    let total_versions_failed = 0;
    const errors: string[] = [];

    for (const drive of drives) {
      const prev_delta = options.force_full
        ? undefined
        : previous_cursor?.delta_link_by_drive[drive.drive_id];
      const delta = await this._connector.fetch_delta(
        tenant_id,
        owner_id,
        drive.drive_id,
        prev_delta,
      );
      delta_link_by_drive[drive.drive_id] = delta.delta_link;

      for (const item of delta.items) {
        if (item.kind !== 'file') continue;
        const change_type = classify_change_type(
          item,
          previous_path_by_file_id,
          previous_name_by_file_id,
          previous_etag_by_file_id,
        );
        if (!change_type) continue;

        if (item.deleted) {
          deleted_items++;
          entries.push(build_deleted_entry(item, change_type));
          delete previous_path_by_file_id[item.item_id];
          delete previous_name_by_file_id[item.item_id];
          delete previous_etag_by_file_id[item.item_id];
          continue;
        }

        const result = await this.process_file(item, owner_id, ctx);
        if (!result) {
          errors.push(`Failed to process file ${item.file_name} (${item.item_id})`);
          continue;
        }

        if (result.deduplicated) files_deduplicated++;
        if (result.stored) files_stored++;

        const version_result = await sync_file_versions(
          this._connector,
          item,
          owner_id,
          snapshot_id,
          ctx,
          this._file_indexes,
        );
        accumulate_version_stats(
          version_result,
          { total_versions_stored, total_versions_unavailable, total_versions_failed },
          (s, u, f) => {
            total_versions_stored = s;
            total_versions_unavailable = u;
            total_versions_failed = f;
          },
        );

        entries.push(build_stored_entry(item, result.storage_key, result.checksum, change_type));
        previous_path_by_file_id[item.item_id] = item.parent_path;
        previous_name_by_file_id[item.item_id] = item.file_name;
        if (item.etag) previous_etag_by_file_id[item.item_id] = item.etag;
      }
    }

    const cursor: OneDriveDeltaCursor = {
      owner_id,
      delta_link_by_drive,
      previous_path_by_file_id,
      previous_name_by_file_id,
      previous_etag_by_file_id,
      updated_at: new Date().toISOString(),
    };

    if (total_versions_failed > 0) {
      errors.push(`${total_versions_failed} version download(s) failed unexpectedly`);
    }
    const healthy = errors.length === 0;

    if (entries.length === 0) {
      await this._cursors.save(ctx, cursor);
      return build_empty_result(
        owner_id,
        drives.length,
        files_stored,
        files_deduplicated,
        deleted_items,
        total_versions_stored,
        total_versions_unavailable,
        errors,
        healthy,
      );
    }

    const snapshot = build_snapshot_manifest(
      tenant_id,
      owner_id,
      entries,
      snapshot_id,
      manifest_created_at,
      options.owner_email,
      options.owner_display_name,
    );
    await this._manifests.save(ctx, snapshot);

    for (const entry of entries) {
      await this._file_indexes.append_version(ctx, owner_id, entry.file_id, {
        snapshot_id: snapshot.snapshot_id,
        backup_at: entry.backup_at,
        drive_id: entry.drive_id,
        file_name: entry.file_name,
        parent_path: entry.parent_path,
        size_bytes: entry.size_bytes,
        change_type: entry.change_type,
        ...(entry.web_url !== undefined ? { web_url: entry.web_url } : {}),
        ...(entry.storage_key !== undefined ? { storage_key: entry.storage_key } : {}),
        ...(entry.checksum !== undefined ? { checksum: entry.checksum } : {}),
        ...(entry.etag !== undefined ? { etag: entry.etag } : {}),
        ...(entry.last_modified_at !== undefined
          ? { last_modified_at: entry.last_modified_at }
          : {}),
      });
    }

    await this._cursors.save(ctx, cursor);

    return {
      owner_id,
      snapshot,
      summary: {
        drives_scanned: drives.length,
        files_changed: entries.length,
        files_stored,
        files_deduplicated,
        deleted_items,
        cursor_updated: true,
        snapshot_created: true,
        versions_stored: total_versions_stored,
        versions_unavailable: total_versions_unavailable,
        errors,
        healthy,
      },
    };
  }

  /** Downloads or reuses storage for a non-deleted delta file. */
  private async process_file(
    item: OneDriveDeltaItem,
    owner_id: string,
    ctx: TenantContext,
  ): Promise<
    { storage_key: string; checksum: string; stored: boolean; deduplicated: boolean } | undefined
  > {
    if (item.size_bytes >= LARGE_FILE_THRESHOLD) {
      try {
        return await process_large_file(this._connector, item, owner_id, ctx);
      } catch (err) {
        logger.warn(
          `Skipping large file ${item.item_id} (${item.file_name}): ${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      }
    }

    const raw_body = await download_with_retry(this._connector, item);
    if (!raw_body) return undefined;

    const checksum = compute_sha256_chunked(raw_body);
    const storage_key = onedrive_data_key(owner_id, checksum);
    const exists = await ctx.storage.exists(storage_key);

    if (!exists) {
      await ctx.storage.put(storage_key, ctx.encrypt(raw_body), {
        'x-onedrive-file-id': item.item_id,
        'x-plaintext-sha256': checksum,
      });
      return { storage_key, checksum, stored: true, deduplicated: false };
    }

    return { storage_key, checksum, stored: false, deduplicated: true };
  }
}

/** @throws Error when no drives are returned (likely missing Graph permissions). */
function ensure_drives_discovered(drive_count: number): void {
  if (drive_count > 0) return;
  throw new Error(
    'Missing Microsoft Graph application permissions for OneDrive: Files.Read.All, Sites.Read.All.',
  );
}

/** Computes SHA-256 in chunks to avoid ERR_OUT_OF_RANGE on buffers > 2 GB. */
function compute_sha256_chunked(data: Buffer): string {
  const hash = createHash('sha256');
  for (let offset = 0; offset < data.length; offset += HASH_CHUNK_SIZE) {
    hash.update(data.subarray(offset, Math.min(offset + HASH_CHUNK_SIZE, data.length)));
  }
  return hash.digest('hex');
}
