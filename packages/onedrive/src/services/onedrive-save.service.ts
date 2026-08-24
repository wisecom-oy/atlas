import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import {
  begin_operation_progress,
  emit_operation_progress,
  finish_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
import { createHash, timingSafeEqual } from 'node:crypto';
import { inject, injectable } from 'inversify';
import type {
  OneDriveManifestEntry,
  OneDriveManifestRepository,
  OneDriveSaveUseCase,
  FileSaveOptions,
  FileSaveResult,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  ONEDRIVE_MANIFEST_REPOSITORY_TOKEN,
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
} from '@/services/onedrive-restore-streaming';
import { filter_onedrive_entries } from '@/services/onedrive-entry-filter';
import {
  load_onedrive_chain_entries,
  restorable_entries,
} from '@/services/onedrive-manifest-chain';

@injectable()
export class OneDriveSaveService implements OneDriveSaveUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(ONEDRIVE_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: OneDriveManifestRepository,
  ) {}

  /** Saves files from a OneDrive snapshot to a local zip archive. */
  async save_snapshot(
    tenant_id: string,
    owner_id: string,
    options: FileSaveOptions,
  ): Promise<FileSaveResult> {
    owner_id = normalize_owner_id(owner_id);
    if (begin_operation_progress(options, 'save', 'onedrive')) {
      finish_operation_progress(options, 'save', 'onedrive', 0, 0);
      return this.empty_result(options.snapshot_id, options.output_path ?? '', true);
    }
    const ctx = await this._tenant_factory.create(tenant_id);
    try {
      const chain = await load_onedrive_chain_entries(
        this._manifests,
        ctx,
        owner_id,
        options.snapshot_id,
      );
      const restorable = filter_onedrive_entries(
        restorable_entries(chain.entries),
        options.file_filter,
      );

      if (restorable.length === 0) {
        const interrupted = finish_operation_progress(options, 'save', 'onedrive', 0, 0);
        return this.empty_result(options.snapshot_id, options.output_path ?? '', interrupted);
      }

      const output_path =
        options.output_path ?? build_default_output_path('onedrive', options.snapshot_id);
      const skip_integrity = options.skip_integrity_check ?? false;
      const { archive, promise } = create_file_archive(output_path);

      const integrity_failures: string[] = [];
      const { files_saved, files_skipped, errors } = await this.save_restorable_entries_to_archive(
        ctx,
        archive,
        restorable,
        skip_integrity,
        integrity_failures,
        options,
      );

      emit_operation_progress(options, {
        operation: 'save',
        workload: 'onedrive',
        phase: 'finalizing',
        processed: files_saved + files_skipped,
        total: restorable.length,
      });
      await finalize_file_archive(archive);
      const total_bytes = await promise;
      const interrupted =
        files_saved + files_skipped < restorable.length || options.should_interrupt?.() === true;
      emit_operation_progress(options, {
        operation: 'save',
        workload: 'onedrive',
        phase: interrupted ? 'interrupted' : 'completed',
        processed: files_saved + files_skipped,
        total: restorable.length,
      });

      return {
        snapshot_id: options.snapshot_id,
        files_saved,
        files_skipped,
        errors,
        integrity_failures,
        output_path,
        total_bytes,
        interrupted,
      };
    } finally {
      ctx.destroy();
    }
  }

  /** Saves sequential entries until cancellation, reporting partial counts. */
  private async save_restorable_entries_to_archive(
    ctx: TenantContext,
    archive: Parameters<typeof add_file_to_archive>[0],
    entries: OneDriveManifestEntry[],
    skip_integrity: boolean,
    integrity_failures: string[],
    options: FileSaveOptions,
  ): Promise<{ files_saved: number; files_skipped: number; errors: string[] }> {
    let files_saved = 0;
    let files_skipped = 0;
    const errors: string[] = [];
    emit_operation_progress(options, {
      operation: 'save',
      workload: 'onedrive',
      phase: 'processing',
      processed: 0,
      total: entries.length,
    });

    for (const entry of entries) {
      if (options.should_interrupt?.() === true) break;
      try {
        const content = await this.download_and_decrypt(
          ctx,
          entry,
          skip_integrity,
          integrity_failures,
        );
        if (!content) {
          files_skipped++;
        } else {
          await add_file_to_archive(archive, entry.parent_path, entry.file_name, content);
          files_saved++;
          logger.info(`Saved: ${entry.parent_path}/${entry.file_name}`);
        }
      } catch (err) {
        errors.push(`${entry.file_name}: ${err instanceof Error ? err.message : String(err)}`);
        files_skipped++;
      }
      emit_operation_progress(options, {
        operation: 'save',
        workload: 'onedrive',
        phase: 'processing',
        processed: files_saved + files_skipped,
        total: entries.length,
        current: entry.file_name,
      });
    }

    return { files_saved, files_skipped, errors };
  }

  private async download_and_decrypt(
    ctx: TenantContext,
    entry: OneDriveManifestEntry,
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
    entry: OneDriveManifestEntry,
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

  private empty_result(
    snapshot_id: string,
    output_path: string,
    interrupted = false,
  ): FileSaveResult {
    return {
      snapshot_id,
      files_saved: 0,
      files_skipped: 0,
      errors: [],
      integrity_failures: [],
      output_path,
      total_bytes: 0,
      interrupted,
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
