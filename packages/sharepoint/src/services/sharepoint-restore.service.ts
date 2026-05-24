import { createHash, timingSafeEqual } from 'node:crypto';
import { inject, injectable } from 'inversify';
import type {
  SharePointSiteConnector,
  SharePointManifestEntry,
  SharePointManifestRepository,
  SharePointRestoreOptions,
  SharePointRestoreResult,
  SharePointRestoreUseCase,
  TenantContext,
  TenantContextFactory,
} from '@atlas/types';
import {
  SHAREPOINT_CONNECTOR_TOKEN,
  SHAREPOINT_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@atlas/types';
import { logger } from '@atlas/core/utils/logger';
import {
  should_stream_restore,
  stream_decrypt_from_storage,
  verify_streaming_checksum,
} from '@/services/sharepoint-restore-streaming';

const SMALL_FILE_LIMIT = 4 * 1024 * 1024;

/** Thrown when ciphertext decrypts with AES-GCM but fails the authentication tag check. */
export class SharePointDecryptAuthError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SharePointDecryptAuthError';
  }
}

@injectable()
export class SharePointRestoreService implements SharePointRestoreUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(SHAREPOINT_CONNECTOR_TOKEN) private readonly _connector: SharePointSiteConnector,
    @inject(SHAREPOINT_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: SharePointManifestRepository,
  ) {}

  /** Restores files from a snapshot back to the site's document libraries. */
  async restore_sharepoint(
    tenant_id: string,
    site_id: string,
    options: SharePointRestoreOptions,
  ): Promise<SharePointRestoreResult> {
    const ctx = await this._tenant_factory.create(tenant_id);
    const manifest = await this._manifests.find_by_snapshot(ctx, site_id, options.snapshot_id);
    if (!manifest) {
      throw new Error(`Snapshot ${options.snapshot_id} not found for site ${site_id}`);
    }

    const target_site = options.target_site_id ?? site_id;
    const conflict = options.conflict_behavior ?? 'rename';
    const entries = this.filter_entries(manifest.entries, options.file_filter);

    // Folder cache keyed by "drive_id:path" since entries span multiple document libraries
    const folder_ids = new Map<string, string>();
    let files_restored = 0;
    let files_skipped = 0;
    const errors: string[] = [];

    const restorable = [...entries].filter((e) => e.change_type !== 'deleted' && e.storage_key);

    for (const entry of restorable) {
      try {
        const parent_id = await this.ensure_folder_path(
          tenant_id,
          target_site,
          entry.drive_id,
          entry.parent_path,
          folder_ids,
        );

        if (parent_id === undefined) {
          errors.push(
            `Could not create folder path: ${entry.parent_path} in drive ${entry.drive_id}`,
          );
          files_skipped++;
          continue;
        }

        const content = await this.download_and_decrypt(ctx, entry);
        if (!content) {
          files_skipped++;
          continue;
        }

        if (content.length <= SMALL_FILE_LIMIT) {
          await this._connector.upload_small_file(
            tenant_id,
            target_site,
            entry.drive_id,
            parent_id,
            entry.file_name,
            content,
            conflict,
          );
        } else {
          await this._connector.upload_large_file(
            tenant_id,
            target_site,
            entry.drive_id,
            parent_id,
            entry.file_name,
            content,
            conflict,
          );
        }

        files_restored++;
        logger.info(`Restored: ${entry.parent_path}/${entry.file_name} (drive: ${entry.drive_id})`);
      } catch (err) {
        if (err instanceof SharePointDecryptAuthError) {
          const msg = `${entry.file_name}: ${err.message}`;
          errors.push(msg);
          files_skipped++;
          logger.warn(`Skipped ${entry.file_name}: ${msg}`);
          continue;
        }
        const msg = `${entry.file_name}: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(msg);
        files_skipped++;
        logger.warn(`Skipped ${entry.file_name}: ${msg}`);
      }
    }

    const unique_drive_folder_keys = new Set([...folder_ids.keys()].map((k) => k));
    const folders_created = Math.max(0, unique_drive_folder_keys.size);

    return {
      snapshot_id: options.snapshot_id,
      files_restored,
      folders_created,
      files_skipped,
      errors,
    };
  }

  private filter_entries(
    entries: readonly SharePointManifestEntry[],
    file_filter?: string[],
  ): SharePointManifestEntry[] {
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
    site_id: string,
    drive_id: string,
    path: string,
    folder_ids: Map<string, string>,
  ): Promise<string | undefined> {
    const normalized = path.length === 0 || path === '.' ? '/' : path;
    const cache_key = `${drive_id}:${normalized}`;
    if (folder_ids.has(cache_key)) return folder_ids.get(cache_key)!;

    // Root always resolves to 'root'
    if (normalized === '/') {
      folder_ids.set(cache_key, 'root');
      return 'root';
    }

    const segments = normalized.split('/').filter(Boolean);
    let current_path = '';
    let parent_id = 'root';

    for (const segment of segments) {
      current_path = current_path ? `${current_path}/${segment}` : `/${segment}`;
      const segment_key = `${drive_id}:${current_path}`;
      if (folder_ids.has(segment_key)) {
        parent_id = folder_ids.get(segment_key)!;
        continue;
      }

      try {
        const folder_id = await this._connector.create_folder(
          tenant_id,
          site_id,
          drive_id,
          parent_id,
          segment,
        );
        folder_ids.set(segment_key, folder_id);
        parent_id = folder_id;
      } catch (err) {
        logger.warn(
          `Failed to create folder ${current_path} in drive ${drive_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      }
    }

    return parent_id;
  }

  private async download_and_decrypt(
    ctx: TenantContext,
    entry: SharePointManifestEntry,
  ): Promise<Buffer | undefined> {
    if (!entry.storage_key) return undefined;

    if (should_stream_restore(entry)) {
      return this.stream_download_and_decrypt(ctx, entry);
    }

    return this.buffered_download_and_decrypt(ctx, entry);
  }

  private async stream_download_and_decrypt(
    ctx: TenantContext,
    entry: SharePointManifestEntry,
  ): Promise<Buffer | undefined> {
    try {
      const { content, sha256_hex } = await stream_decrypt_from_storage(ctx, entry.storage_key!);
      if (!verify_streaming_checksum(entry, sha256_hex)) return undefined;
      return content;
    } catch (err) {
      if (is_gcm_auth_failure(err)) {
        throw new SharePointDecryptAuthError(
          `AES-GCM authentication failed for ${entry.file_name}`,
          { cause: err },
        );
      }
      logger.warn(
        `Streaming decrypt failed for ${entry.file_name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  private async buffered_download_and_decrypt(
    ctx: TenantContext,
    entry: SharePointManifestEntry,
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
        throw new SharePointDecryptAuthError(
          `AES-GCM authentication failed for ${entry.file_name}`,
          { cause: err },
        );
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
