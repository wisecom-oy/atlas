import { injectable } from 'inversify';
import { logger } from '@wisecom/atlas-core/utils/logger';
import type {
  OneDriveFileVersionIndex,
  OneDriveFileVersionIndexRepository,
  OneDriveVersionWatermark,
  ReadableVersionIndexListing,
  TenantContext,
} from '@wisecom/atlas-types';
import {
  onedrive_index_prefix,
  onedrive_run_index_key,
  validate_key_segment,
} from '@/services/shared/storage-keys';
import { later_watermark } from '@wisecom/atlas-drive/versioning/version-watermark';
import {
  read_merged_version_indexes,
  read_version_index_object_if_present,
  write_run_version_index,
  type MergedVersionIndexes,
} from '@wisecom/atlas-drive/versioning/version-index-store';

/** Payload of one run's version index object. */
interface RunIndexPayload {
  owner_id: string;
  snapshot_id: string;
  indexes: OneDriveFileVersionIndex[];
}

/**
 * S3-backed version index with one object per backup run
 * (`onedrive/index/<owner>/runs/<snapshot_id>.json`). A 20,000-file drive
 * costs one PUT and one small object per run instead of one object per file,
 * each billed at the provider's minimum size floor (issue #161).
 *
 * Reads scan the owner prefix, so their cost grows with the number of runs
 * (plus any legacy per-file objects still present). Callers that need more
 * than one file's history must call `list_readable_by_owner` once and index
 * the result rather than scanning per file.
 */
@injectable()
export class S3OneDriveFileVersionIndexRepository implements OneDriveFileVersionIndexRepository {
  /**
   * Rebuilds each file's dedup watermark from the owner's index objects.
   *
   * Only rows written by version sync carry `version_id`; the rows copied from
   * manifest entries describe the file's current state, and letting those set
   * the watermark would skip historical versions that were never captured.
   * Only called to seed a cursor written before watermarks existed. An
   * unreadable index object is logged and left out: its versions are then
   * downloaded again rather than skipped, which costs time but loses nothing.
   */
  async load_version_watermarks(
    ctx: TenantContext,
    owner_id: string,
  ): Promise<Record<string, OneDriveVersionWatermark>> {
    const merged = await this.read_indexes(ctx, owner_id);
    for (const key of merged.unreadable_keys) {
      logger.warn(`Version index ${key} could not be read; its versions will be captured again`);
    }
    const watermarks: Record<string, OneDriveVersionWatermark> = {};
    for (const [file_id, versions] of merged.versions_by_file) {
      for (const version of versions) {
        if (!version.version_id) continue;
        const next = later_watermark(
          watermarks[file_id],
          version.last_modified_at,
          version.version_id,
        );
        if (next !== undefined && typeof next !== 'string') watermarks[file_id] = next;
      }
    }
    return watermarks;
  }

  /** Writes the run's captured rows as a single create-only index object; no-op when empty. */
  async write_run_index(
    ctx: TenantContext,
    owner_id: string,
    snapshot_id: string,
    indexes: OneDriveFileVersionIndex[],
  ): Promise<void> {
    if (indexes.length === 0) return;
    validate_key_segment(snapshot_id);
    const payload: RunIndexPayload = { owner_id, snapshot_id, indexes };
    const key = onedrive_run_index_key(owner_id, snapshot_id);
    await write_run_version_index(ctx, { key, provider: 'OneDrive', payload });
  }

  /** Lists per-file version histories for an owner, naming the index objects it could not read. */
  async list_readable_by_owner(
    ctx: TenantContext,
    owner_id: string,
  ): Promise<ReadableVersionIndexListing<OneDriveFileVersionIndex>> {
    const merged = await this.read_indexes(ctx, owner_id);
    return {
      indexes: [...merged.versions_by_file].map(([file_id, versions]) => ({
        file_id,
        owner_id,
        versions,
      })),
      unreadable_keys: merged.unreadable_keys,
    };
  }

  /** Reads the index object at exactly this key; raises when it is damaged. */
  async read_index_object_at(
    ctx: TenantContext,
    storage_key: string,
  ): Promise<OneDriveFileVersionIndex[] | undefined> {
    return (await read_version_index_object_if_present(ctx, storage_key)) as
      OneDriveFileVersionIndex[] | undefined;
  }

  private async read_indexes(ctx: TenantContext, owner_id: string): Promise<MergedVersionIndexes> {
    return read_merged_version_indexes(
      ctx,
      await ctx.storage.list(onedrive_index_prefix(owner_id)),
    );
  }
}
