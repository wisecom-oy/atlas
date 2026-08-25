import { injectable } from 'inversify';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { ConcurrencySemaphore } from '@wisecom/atlas-core/services/shared/concurrency-semaphore';
import type {
  SharePointFileVersionIndex,
  SharePointFileVersionIndexRepository,
  SharePointVersionWatermark,
  TenantContext,
} from '@wisecom/atlas-types';
import {
  sharepoint_index_prefix,
  sharepoint_run_index_key,
  validate_key_segment,
} from '@/services/sharepoint-storage-keys';
import { later_watermark } from '@/services/sharepoint-version-watermark';

/** Payload of one run's version index object. */
interface RunIndexPayload {
  site_id: string;
  snapshot_id: string;
  indexes: SharePointFileVersionIndex[];
}

/**
 * Either a per-run payload or a legacy per-file index written before
 * issue #161. Both stay readable so history recorded by older Atlas versions
 * remains visible until those objects are purged.
 */
type StoredIndexPayload = RunIndexPayload | SharePointFileVersionIndex;

/**
 * Parallel GETs per index read. The objects are small and independent, so the
 * scan is latency-bound; serial awaits leave the process idle. Kept modest
 * because a read can coincide with a backup saturating the same S3 client.
 */
const INDEX_READ_CONCURRENCY = 8;

/**
 * S3-backed version index with one object per backup run
 * (`sharepoint/index/<site>/runs/<snapshot_id>.json`). A 20,000-file site
 * costs one PUT and one small object per run instead of one object per file,
 * each billed at the provider's minimum size floor (issue #161).
 *
 * Reads scan the site prefix, so their cost grows with the number of runs
 * (plus any legacy per-file objects still present). Callers that need more
 * than one file's history must call `list_by_site` once and index the result
 * rather than scanning per file.
 */
@injectable()
export class S3SharePointFileVersionIndexRepository implements SharePointFileVersionIndexRepository {
  /**
   * Rebuilds each file's dedup watermark from the site's index objects.
   *
   * Only rows written by version sync carry `version_id`; the rows copied from
   * manifest entries describe the file's current state, and letting those set
   * the watermark would skip historical versions that were never captured.
   * Only called to seed a cursor written before watermarks existed.
   */
  async load_version_watermarks(
    ctx: TenantContext,
    site_id: string,
  ): Promise<Record<string, SharePointVersionWatermark>> {
    const watermarks: Record<string, SharePointVersionWatermark> = {};
    await this.for_each_index(ctx, site_id, (idx) => {
      for (const version of idx.versions) {
        if (!version.version_id) continue;
        const next = later_watermark(
          watermarks[idx.file_id],
          version.last_modified_at,
          version.version_id,
        );
        if (next !== undefined && typeof next !== 'string') watermarks[idx.file_id] = next;
      }
    });
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
    await ctx.storage.put(
      sharepoint_run_index_key(site_id, snapshot_id),
      ctx.encrypt(Buffer.from(JSON.stringify(payload), 'utf-8')),
    );
  }

  /** Lists per-file version histories for a site, merged across all index objects. */
  async list_by_site(ctx: TenantContext, site_id: string): Promise<SharePointFileVersionIndex[]> {
    const rows_by_file = new Map<string, SharePointFileVersionIndex['versions']>();
    await this.for_each_index(ctx, site_id, (idx) => {
      const rows = rows_by_file.get(idx.file_id);
      if (rows) rows.push(...idx.versions);
      else rows_by_file.set(idx.file_id, [...idx.versions]);
    });
    return [...rows_by_file].map(([file_id, versions]) => ({
      file_id,
      site_id,
      versions: sort_and_deduplicate_versions(versions),
    }));
  }

  /** Streams every index object of the site through `visit`, reading with bounded concurrency. */
  private async for_each_index(
    ctx: TenantContext,
    site_id: string,
    visit: (idx: SharePointFileVersionIndex) => void,
  ): Promise<void> {
    const keys = await ctx.storage.list(sharepoint_index_prefix(site_id));
    const semaphore = new ConcurrencySemaphore(INDEX_READ_CONCURRENCY);
    const reads = await Promise.allSettled(
      keys.map(async (key) => {
        await semaphore.acquire();
        try {
          return await this.download_indexes(ctx, key);
        } finally {
          semaphore.release();
        }
      }),
    );
    for (const read of reads) {
      if (read.status === 'rejected') throw read.reason;
      for (const idx of read.value) visit(idx);
    }
  }

  /**
   * Downloads one index object and returns its per-file indexes.
   *
   * Storage failures propagate: an unread object is indistinguishable from a
   * file with no history, and that value decides both version dedup and
   * verification outcomes, so a transient GET error must not be reported as
   * "nothing recorded". Only an undecryptable or unparseable payload is
   * skipped, and it is logged.
   */
  private async download_indexes(
    ctx: TenantContext,
    key: string,
  ): Promise<SharePointFileVersionIndex[]> {
    const payload = await ctx.storage.get(key);
    try {
      const parsed = JSON.parse(ctx.decrypt(payload).toString('utf-8')) as StoredIndexPayload;
      return 'indexes' in parsed ? parsed.indexes : [parsed];
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(`Skipping unreadable version index object ${key}: ${reason}`);
      return [];
    }
  }
}

/** Orders rows oldest first and drops repeated historical version ids. */
function sort_and_deduplicate_versions(
  versions: SharePointFileVersionIndex['versions'],
): typeof versions {
  versions.sort((a, b) => (a.backup_at < b.backup_at ? -1 : a.backup_at > b.backup_at ? 1 : 0));
  const seen_version_ids = new Set<string>();
  let write_index = 0;
  for (const version of versions) {
    if (version.version_id && seen_version_ids.has(version.version_id)) continue;
    if (version.version_id) seen_version_ids.add(version.version_id);
    versions[write_index++] = version;
  }
  versions.length = write_index;
  return versions;
}
