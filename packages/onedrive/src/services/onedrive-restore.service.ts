import { createHash, timingSafeEqual } from 'node:crypto';
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

const SMALL_FILE_LIMIT = 4 * 1024 * 1024;

/** Thrown when ciphertext decrypts with AES-GCM but fails the authentication tag check. */
export class OneDriveDecryptAuthError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OneDriveDecryptAuthError';
  }
}

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
    const ctx = await this._tenant_factory.create(tenant_id);
    try {
      const manifest = await this._manifests.find_by_snapshot(ctx, owner_id, options.snapshot_id);
      if (!manifest) {
        throw new Error(`Snapshot ${options.snapshot_id} not found`);
      }

      const target_owner = options.target_owner_id ?? owner_id;
      const drives = await this._connector.list_drives(tenant_id, target_owner);
      const [primary_drive] = drives;
      if (!primary_drive) {
        throw new Error('No OneDrive drives found for target user');
      }
      const drive_id = primary_drive.drive_id;

      const conflict = options.conflict_behavior ?? 'rename';
      const entries = this.filter_entries(manifest.entries, options.file_filter);
      const folder_ids = new Map<string, string>();
      folder_ids.set('/', 'root');

      let files_restored = 0;
      let files_skipped = 0;
      const errors: string[] = [];

      const sorted_entries = [...entries].filter(
        (e) => e.change_type !== 'deleted' && e.storage_key,
      );

      for (const entry of sorted_entries) {
        const result = await this.restore_single_entry(
          tenant_id,
          target_owner,
          drive_id,
          entry,
          ctx,
          folder_ids,
          conflict,
        );
        if (result.restored) {
          files_restored++;
        } else {
          files_skipped++;
          if (result.error) errors.push(result.error);
        }
      }

      const folders_created = Math.max(0, folder_ids.size - 1);

      return {
        snapshot_id: options.snapshot_id,
        files_restored,
        folders_created,
        files_skipped,
        errors,
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
  ): Promise<{ restored: boolean; error?: string }> {
    try {
      const parent_id = await this.ensure_folder_path(
        tenant_id,
        target_owner,
        drive_id,
        entry.parent_path,
        folder_ids,
      );

      if (parent_id === undefined) {
        return { restored: false, error: `Could not create folder path: ${entry.parent_path}` };
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
          entry.file_name,
          content,
          conflict,
        );
      } else {
        await this._connector.upload_large_file(
          tenant_id,
          target_owner,
          drive_id,
          parent_id,
          entry.file_name,
          content,
          conflict,
        );
      }

      logger.info(`Restored: ${entry.parent_path}/${entry.file_name}`);
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

  private filter_entries(
    entries: readonly OneDriveManifestEntry[],
    file_filter?: string[],
  ): OneDriveManifestEntry[] {
    if (!file_filter || file_filter.length === 0) return [...entries];
    const filter_set = new Set(file_filter.map((f) => f.toLowerCase()));
    return entries.filter(
      (e) =>
        filter_set.has(e.file_id) ||
        filter_set.has(`${e.parent_path}/${e.file_name}`.toLowerCase()),
    );
  }

  private async ensure_folder_path(
    tenant_id: string,
    owner_id: string,
    drive_id: string,
    path: string,
    folder_ids: Map<string, string>,
  ): Promise<string | undefined> {
    const normalized = path.length === 0 || path === '.' ? '/' : path;
    if (folder_ids.has(normalized)) return folder_ids.get(normalized)!;

    const segments = normalized.split('/').filter(Boolean);
    let current_path = '';
    let parent_id = 'root';

    for (const segment of segments) {
      current_path = current_path ? `${current_path}/${segment}` : `/${segment}`;
      if (folder_ids.has(current_path)) {
        parent_id = folder_ids.get(current_path)!;
        continue;
      }

      try {
        const folder_id = await this._connector.create_folder(
          tenant_id,
          owner_id,
          drive_id,
          parent_id,
          segment,
        );
        folder_ids.set(current_path, folder_id);
        parent_id = folder_id;
      } catch (err) {
        logger.warn(
          `Failed to create folder ${current_path}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      }
    }

    return parent_id;
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

function is_gcm_auth_failure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return msg.includes('Unsupported state') || lower.includes('auth');
}

function plaintext_sha256_equals_expected(content: Buffer, expected_hex: string): boolean {
  const actual_hex = createHash('sha256').update(content).digest('hex');
  if (actual_hex.length !== expected_hex.length) return false;
  return timingSafeEqual(Buffer.from(actual_hex, 'utf8'), Buffer.from(expected_hex, 'utf8'));
}
