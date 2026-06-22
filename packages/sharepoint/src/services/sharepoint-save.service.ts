import { createHash, timingSafeEqual } from 'node:crypto';
import { inject, injectable } from 'inversify';
import type {
  SharePointManifestEntry,
  SharePointManifestRepository,
  SharePointSaveUseCase,
  FileSaveOptions,
  FileSaveResult,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  SHAREPOINT_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import {
  create_file_archive,
  add_file_to_archive,
  finalize_file_archive,
} from '@wisecom/atlas-core/services/shared/file-save-zip-writer';
import {
  should_stream_restore,
  stream_decrypt_from_storage,
  verify_streaming_checksum,
} from '@/services/sharepoint-restore-streaming';

@injectable()
export class SharePointSaveService implements SharePointSaveUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(SHAREPOINT_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: SharePointManifestRepository,
  ) {}

  /** Saves files from a SharePoint snapshot to a local zip archive. */
  async save_snapshot(
    tenant_id: string,
    site_id: string,
    options: FileSaveOptions,
  ): Promise<FileSaveResult> {
    const ctx = await this._tenant_factory.create(tenant_id);
    try {
      const manifest = await this._manifests.find_by_snapshot(ctx, site_id, options.snapshot_id);
      if (!manifest) {
        throw new Error(`Snapshot ${options.snapshot_id} not found for site ${site_id}`);
      }

      const entries = this.filter_entries(manifest.entries, options.file_filter);
      const restorable = entries.filter((e) => e.change_type !== 'deleted' && e.storage_key);

      if (restorable.length === 0) {
        return this.empty_result(options.snapshot_id, options.output_path ?? '');
      }

      const output_path =
        options.output_path ?? build_default_output_path('sharepoint', options.snapshot_id);
      const skip_integrity = options.skip_integrity_check ?? false;
      const { archive, promise } = create_file_archive(output_path);

      let files_saved = 0;
      let files_skipped = 0;
      const errors: string[] = [];
      const integrity_failures: string[] = [];

      for (const entry of restorable) {
        try {
          const content = await this.download_and_decrypt(
            ctx,
            entry,
            skip_integrity,
            integrity_failures,
          );
          if (!content) {
            files_skipped++;
            continue;
          }
          await add_file_to_archive(archive, entry.parent_path, entry.file_name, content);
          files_saved++;
          logger.info(`Saved: ${entry.parent_path}/${entry.file_name}`);
        } catch (err) {
          const msg = `${entry.file_name}: ${err instanceof Error ? err.message : String(err)}`;
          errors.push(msg);
          files_skipped++;
        }
      }

      await finalize_file_archive(archive);
      const total_bytes = await promise;

      return {
        snapshot_id: options.snapshot_id,
        files_saved,
        files_skipped,
        errors,
        integrity_failures,
        output_path,
        total_bytes,
      };
    } finally {
      ctx.destroy();
    }
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

  private async download_and_decrypt(
    ctx: TenantContext,
    entry: SharePointManifestEntry,
    skip_integrity: boolean,
    integrity_failures: string[],
  ): Promise<Buffer | undefined> {
    if (!entry.storage_key) return undefined;

    if (should_stream_restore(entry)) {
      try {
        const { content, sha256_hex } = await stream_decrypt_from_storage(ctx, entry.storage_key);
        if (!skip_integrity && !verify_streaming_checksum(entry, sha256_hex)) {
          integrity_failures.push(entry.file_id);
          return undefined;
        }
        return content;
      } catch (err) {
        logger.warn(
          `Streaming decrypt failed for ${entry.file_name}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      }
    }

    return this.buffered_decrypt(ctx, entry, skip_integrity, integrity_failures);
  }

  private async buffered_decrypt(
    ctx: TenantContext,
    entry: SharePointManifestEntry,
    skip_integrity: boolean,
    integrity_failures: string[],
  ): Promise<Buffer | undefined> {
    try {
      const ciphertext = await ctx.storage.get(entry.storage_key!);
      const content = ctx.decrypt(ciphertext);
      if (!skip_integrity && entry.checksum) {
        if (!sha256_matches(content, entry.checksum)) {
          integrity_failures.push(entry.file_id);
          logger.warn(`Checksum mismatch for ${entry.file_name}; skipping`);
          return undefined;
        }
      }
      return content;
    } catch (err) {
      logger.warn(
        `Failed to decrypt ${entry.file_name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  private empty_result(snapshot_id: string, output_path: string): FileSaveResult {
    return {
      snapshot_id,
      files_saved: 0,
      files_skipped: 0,
      errors: [],
      integrity_failures: [],
      output_path,
      total_bytes: 0,
    };
  }
}

function sha256_matches(content: Buffer, expected: string): boolean {
  const actual = createHash('sha256').update(content).digest('hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual, 'utf8'), Buffer.from(expected, 'utf8'));
}

function build_default_output_path(prefix: string, snapshot_id: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${prefix}-${snapshot_id}-${ts}.zip`;
}
