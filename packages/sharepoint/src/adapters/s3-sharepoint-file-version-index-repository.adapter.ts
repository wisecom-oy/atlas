import { injectable } from 'inversify';
import { logger } from '@wisecom/atlas-core/utils/logger';
import type {
  SharePointFileVersionIndex,
  SharePointFileVersionIndexRepository,
  SharePointVersionWatermark,
  ReadableVersionIndexListing,
  TenantContext,
} from '@wisecom/atlas-types';
import {
  sharepoint_index_prefix,
  sharepoint_run_index_key,
  validate_key_segment,
} from '@/services/shared/storage-keys';
import { later_watermark } from '@wisecom/atlas-drive/versioning/version-watermark';
import {
  read_merged_version_indexes,
  read_version_index_object_if_present,
  type MergedVersionIndexes,
} from '@wisecom/atlas-drive/versioning/version-index-store';

/** Payload of one run's version index object. */
interface RunIndexPayload {
  site_id: string;
  snapshot_id: string;
  indexes: SharePointFileVersionIndex[];
}

/**
 * S3-backed version index with one object per backup run
 * (`sharepoint/index/<site>/runs/<snapshot_id>.json`). A 20,000-file site
 * costs one PUT and one small object per run instead of one object per file,
 * each billed at the provider's minimum size floor (issue #161).
 *
 * Reads scan the site prefix, so their cost grows with the number of runs
 * (plus any legacy per-file objects still present). Callers that need more
 * than one file's history must call `list_readable_by_site` once and index
 * the result rather than scanning per file.
 */
@injectable()
export class S3SharePointFileVersionIndexRepository implements SharePointFileVersionIndexRepository {
  /**
   * Rebuilds each file's dedup watermark from the site's index objects.
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
    site_id: string,
  ): Promise<Record<string, SharePointVersionWatermark>> {
    const merged = await this.read_indexes(ctx, site_id);
    for (const key of merged.unreadable_keys) {
      logger.warn(`Version index ${key} could not be read; its versions will be captured again`);
    }
    const watermarks: Record<string, SharePointVersionWatermark> = {};
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
    site_id: string,
    snapshot_id: string,
    indexes: SharePointFileVersionIndex[],
  ): Promise<void> {
    if (indexes.length === 0) return;
    validate_key_segment(snapshot_id);
    const payload: RunIndexPayload = { site_id, snapshot_id, indexes };
    const key = sharepoint_run_index_key(site_id, snapshot_id);
    await ctx.storage.put(key, ctx.encrypt(Buffer.from(JSON.stringify(payload), 'utf-8'), key));
  }

  /** Lists per-file version histories for a site, naming the index objects it could not read. */
  async list_readable_by_site(
    ctx: TenantContext,
    site_id: string,
  ): Promise<ReadableVersionIndexListing<SharePointFileVersionIndex>> {
    const merged = await this.read_indexes(ctx, site_id);
    return {
      indexes: [...merged.versions_by_file].map(([file_id, versions]) => ({
        file_id,
        site_id,
        versions,
      })),
      unreadable_keys: merged.unreadable_keys,
    };
  }

  /** Reads the index object at exactly this key; raises when it is damaged. */
  async read_index_object_at(
    ctx: TenantContext,
    storage_key: string,
  ): Promise<SharePointFileVersionIndex[] | undefined> {
    return (await read_version_index_object_if_present(ctx, storage_key)) as
      SharePointFileVersionIndex[] | undefined;
  }

  private async read_indexes(ctx: TenantContext, site_id: string): Promise<MergedVersionIndexes> {
    return read_merged_version_indexes(
      ctx,
      await ctx.storage.list(sharepoint_index_prefix(site_id)),
    );
  }
}
