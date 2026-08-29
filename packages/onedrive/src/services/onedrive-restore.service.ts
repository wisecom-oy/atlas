import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import {
  begin_operation_progress,
  emit_operation_progress,
  finish_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
import { inject, injectable } from 'inversify';
import type {
  OneDriveConnector,
  OneDriveManifestEntry,
  OneDriveManifestRepository,
  OneDriveRestoreOptions,
  OneDriveRestoreResult,
  OneDriveRestoreUseCase,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  ONEDRIVE_CONNECTOR_TOKEN,
  ONEDRIVE_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import {
  should_stream_restore,
  stream_decrypt_from_storage,
  verify_streaming_checksum,
} from '@/services/onedrive-restore-streaming';
import { is_gcm_auth_failure } from '@wisecom/atlas-core/utils/gcm-auth';
import {
  OneDriveDecryptAuthError,
  plaintext_sha256_equals_expected,
} from '@/services/onedrive-restore-integrity';
import { filter_onedrive_entries } from '@/services/onedrive-entry-filter';
import {
  load_onedrive_chain_entries,
  restorable_entries,
} from '@/services/onedrive-manifest-chain';
import { empty_restore_result } from '@/services/onedrive-restore-result';
import {
  assert_renameable,
  resolve_restore_root,
  restore_parent_path,
} from '@wisecom/atlas-core/services/shared/restore-destination';
import { ensure_onedrive_folder_path } from '@/services/onedrive-restore-folder-path';

const SMALL_FILE_LIMIT = 4 * 1024 * 1024;

@injectable()
export class OneDriveRestoreService implements OneDriveRestoreUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(ONEDRIVE_CONNECTOR_TOKEN) private readonly _connector: OneDriveConnector,
    @inject(ONEDRIVE_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: OneDriveManifestRepository,
  ) {}

  /** Restores files from a snapshot to the target user's OneDrive. */
  async restore_onedrive(
    tenant_id: string,
    owner_id: string,
    options: OneDriveRestoreOptions,
  ): Promise<OneDriveRestoreResult> {
    owner_id = normalize_owner_id(owner_id);
    if (begin_operation_progress(options, 'restore', 'onedrive')) {
      finish_operation_progress(options, 'restore', 'onedrive', 0, 0);
      return empty_restore_result(options.snapshot_id);
    }
    const ctx = await this._tenant_factory.create(tenant_id);
    try {
      const chain = await load_onedrive_chain_entries(
        this._manifests,
        ctx,
        owner_id,
        options.snapshot_id,
      );

      const target_owner = options.target_owner_id ?? owner_id;
      const drives = await this._connector.list_drives(tenant_id, target_owner);
      const [primary_drive] = drives;
      if (!primary_drive) {
        throw new Error('No OneDrive drives found for target user');
      }
      const drive_id = primary_drive.drive_id;

      const conflict = options.conflict_behavior ?? 'rename';
      const restorable = filter_onedrive_entries(
        restorable_entries(chain.entries),
        options.file_filter,
      );
      assert_renameable(options.rename_to, restorable.length);
      const restore_root = resolve_restore_root(options);
      const folder_ids = new Map<string, string>();
      folder_ids.set('/', 'root');

      let files_restored = 0;
      let files_skipped = 0;
      const errors: string[] = [];

      emit_operation_progress(options, {
        operation: 'restore',
        workload: 'onedrive',
        phase: 'processing',
        processed: 0,
        total: restorable.length,
      });

      for (const entry of restorable) {
        if (options.should_interrupt?.() === true) break;
        const result = await this.restore_single_entry(
          tenant_id,
          target_owner,
          drive_id,
          entry,
          ctx,
          folder_ids,
          conflict,
          { root: restore_root, file_name: options.rename_to ?? entry.file_name },
        );
        if (result.restored) {
          files_restored++;
        } else {
          files_skipped++;
          if (result.error) errors.push(result.error);
        }
        emit_operation_progress(options, {
          operation: 'restore',
          workload: 'onedrive',
          phase: 'processing',
          processed: files_restored + files_skipped,
          total: restorable.length,
          current: entry.file_name,
        });
      }

      const folders_created = Math.max(0, folder_ids.size - 1);
      const interrupted = finish_operation_progress(
        options,
        'restore',
        'onedrive',
        files_restored + files_skipped,
        restorable.length,
        files_restored + files_skipped < restorable.length,
      );

      return {
        snapshot_id: options.snapshot_id,
        files_restored,
        folders_created,
        files_skipped,
        errors,
        interrupted,
      };
    } finally {
      ctx.destroy();
    }
  }

  /** Restores one manifest entry to the target drive, returning success or skip reason. */
  private async restore_single_entry(
    tenant_id: string,
    target_owner: string,
    drive_id: string,
    entry: OneDriveManifestEntry,
    ctx: TenantContext,
    folder_ids: Map<string, string>,
    conflict: NonNullable<OneDriveRestoreOptions['conflict_behavior']>,
    placement: { readonly root: string; readonly file_name: string },
  ): Promise<{ restored: boolean; error?: string }> {
    const target_path = restore_parent_path(placement.root, entry.parent_path);
    try {
      const parent_id = await ensure_onedrive_folder_path(
        this._connector,
        tenant_id,
        target_owner,
        drive_id,
        target_path,
        folder_ids,
      );

      if (parent_id === undefined) {
        return { restored: false, error: `Could not create folder path: ${target_path}` };
      }

      const content = await this.download_and_decrypt(ctx, entry);
      if (!content) {
        return { restored: false };
      }

      if (content.length <= SMALL_FILE_LIMIT) {
        await this._connector.upload_small_file(
          tenant_id,
          target_owner,
          drive_id,
          parent_id,
          placement.file_name,
          content,
          conflict,
          entry.file_system_info,
        );
      } else {
        await this._connector.upload_large_file(
          tenant_id,
          target_owner,
          drive_id,
          parent_id,
          placement.file_name,
          content,
          conflict,
          entry.file_system_info,
        );
      }

      logger.info(`Restored: ${target_path}/${placement.file_name}`);
      return { restored: true };
    } catch (err) {
      if (err instanceof OneDriveDecryptAuthError) {
        const msg = `${entry.file_name}: ${err.message}`;
        logger.warn(`Skipped ${entry.file_name}: ${msg}`);
        return { restored: false, error: msg };
      }
      const msg = `${entry.file_name}: ${err instanceof Error ? err.message : String(err)}`;
      logger.warn(`Skipped ${entry.file_name}: ${msg}`);
      return { restored: false, error: msg };
    }
  }

  private async download_and_decrypt(
    ctx: TenantContext,
    entry: OneDriveManifestEntry,
  ): Promise<Buffer | undefined> {
    if (!entry.storage_key) return undefined;

    if (should_stream_restore(entry)) {
      return this.stream_download_and_decrypt(ctx, entry);
    }

    return this.buffered_download_and_decrypt(ctx, entry);
  }

  /** Streaming path: avoids holding the full ciphertext in memory for large files. */
  private async stream_download_and_decrypt(
    ctx: TenantContext,
    entry: OneDriveManifestEntry,
  ): Promise<Buffer | undefined> {
    try {
      const { content, sha256_hex } = await stream_decrypt_from_storage(ctx, entry.storage_key!);
      if (!verify_streaming_checksum(entry, sha256_hex)) return undefined;
      return content;
    } catch (err) {
      if (is_gcm_auth_failure(err)) {
        throw new OneDriveDecryptAuthError(`AES-GCM authentication failed for ${entry.file_name}`, {
          cause: err,
        });
      }
      logger.warn(
        `Streaming decrypt failed for ${entry.file_name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  /** Buffered path: simple and safe for small files at or below SMALL_FILE_LIMIT. */
  private async buffered_download_and_decrypt(
    ctx: TenantContext,
    entry: OneDriveManifestEntry,
  ): Promise<Buffer | undefined> {
    let encrypted: Buffer;
    try {
      encrypted = await ctx.storage.get(entry.storage_key!);
    } catch (err) {
      logger.warn(
        `Missing or unreadable blob for ${entry.file_name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
    try {
      const content = ctx.decrypt(encrypted);
      const expected = entry.checksum;
      if (!expected || !plaintext_sha256_equals_expected(content, expected)) {
        logger.warn(
          expected
            ? `Checksum mismatch after decrypt for ${entry.file_name}; skipping restore`
            : `Missing checksum for ${entry.file_name}; skipping restore`,
        );
        return undefined;
      }
      return content;
    } catch (err) {
      if (is_gcm_auth_failure(err)) {
        throw new OneDriveDecryptAuthError(`AES-GCM authentication failed for ${entry.file_name}`, {
          cause: err,
        });
      }
      logger.warn(
        `Failed to decrypt ${entry.file_name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }
}
