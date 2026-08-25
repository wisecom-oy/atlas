import { injectable } from 'inversify';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { ConcurrencySemaphore } from '@wisecom/atlas-core/services/shared/concurrency-semaphore';
import type {
  SharePointFileVersionIndex,
  SharePointFileVersionIndexRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import {
  sharepoint_index_prefix,
  sharepoint_run_index_key,
  validate_key_segment,
} from '@/services/sharepoint-storage-keys';

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
  /** Version ids already recorded per file id across the site's index objects. */
  async load_known_version_ids(
    ctx: TenantContext,
    site_id: string,
  ): Promise<Map<string, Set<string>>> {
    // Only the ids are kept: materializing full history for a 20,000-file
    // site just to reduce it to a dedup set costs hundreds of MB.
    const known = new Map<string, Set<string>>();
    await this.for_each_index(ctx, site_id, (idx) => {
      let ids = known.get(idx.file_id);
      if (!ids) known.set(idx.file_id, (ids = new Set<string>()));
      for (const version of idx.versions) {
        if (version.version_id) ids.add(version.version_id);
      }
    });
    return known;
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
      versions: sort_versions(versions),
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

/** Orders version rows oldest first by backup timestamp. */
function sort_versions(versions: SharePointFileVersionIndex['versions']): typeof versions {
  return versions.sort((a, b) =>
    a.backup_at < b.backup_at ? -1 : a.backup_at > b.backup_at ? 1 : 0,
  );
}
