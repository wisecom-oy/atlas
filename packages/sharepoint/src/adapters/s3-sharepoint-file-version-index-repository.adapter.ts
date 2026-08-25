import { injectable } from 'inversify';
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
 * S3-backed version index with one object per backup run
 * (`sharepoint/index/<site>/runs/<snapshot_id>.json`). A 20,000-file site
 * costs one PUT and one small object per run instead of one object per file,
 * each billed at the provider's minimum size floor (issue #161).
 */
@injectable()
export class S3SharePointFileVersionIndexRepository implements SharePointFileVersionIndexRepository {
  /** Version ids already recorded per file id across the site's index objects. */
  async load_known_version_ids(
    ctx: TenantContext,
    site_id: string,
  ): Promise<Map<string, Set<string>>> {
    const indexes = await this.list_by_site(ctx, site_id);
    const known = new Map<string, Set<string>>();
    for (const idx of indexes) {
      known.set(
        idx.file_id,
        new Set(idx.versions.map((v) => v.version_id).filter(Boolean) as string[]),
      );
    }
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

  /** Retrieves the merged version history for a specific file across all index objects. */
  async find_by_file_id(
    ctx: TenantContext,
    site_id: string,
    file_id: string,
  ): Promise<SharePointFileVersionIndex | undefined> {
    const keys = await ctx.storage.list(sharepoint_index_prefix(site_id));
    const versions: SharePointFileVersionIndex['versions'] = [];
    for (const key of keys) {
      for (const idx of await this.download_indexes(ctx, key)) {
        if (idx.file_id === file_id) versions.push(...idx.versions);
      }
    }
    if (versions.length === 0) return undefined;
    return { file_id, site_id, versions: sort_versions(versions) };
  }

  /** Lists per-file version histories for a site, merged across all index objects. */
  async list_by_site(ctx: TenantContext, site_id: string): Promise<SharePointFileVersionIndex[]> {
    const keys = await ctx.storage.list(sharepoint_index_prefix(site_id));
    const by_file = new Map<string, SharePointFileVersionIndex>();
    for (const key of keys) {
      for (const idx of await this.download_indexes(ctx, key)) {
        merge_index(by_file, idx);
      }
    }
    return [...by_file.values()];
  }

  /**
   * Downloads one index object and yields its per-file indexes. Storage or
   * parse failures yield nothing for that object, matching the previous
   * per-file behaviour of skipping unreadable entries.
   */
  private async download_indexes(
    ctx: TenantContext,
    key: string,
  ): Promise<SharePointFileVersionIndex[]> {
    try {
      const payload = await ctx.storage.get(key);
      const parsed = JSON.parse(ctx.decrypt(payload).toString('utf-8')) as StoredIndexPayload;
      return 'indexes' in parsed ? parsed.indexes : [parsed];
    } catch {
      return [];
    }
  }
}

function merge_index(
  by_file: Map<string, SharePointFileVersionIndex>,
  idx: SharePointFileVersionIndex,
): void {
  const existing = by_file.get(idx.file_id);
  const merged = sort_versions(existing ? [...existing.versions, ...idx.versions] : idx.versions);
  by_file.set(idx.file_id, { file_id: idx.file_id, site_id: idx.site_id, versions: merged });
}
function sort_versions(versions: SharePointFileVersionIndex['versions']): typeof versions {
  return [...versions].sort((a, b) =>
    a.backup_at < b.backup_at ? -1 : a.backup_at > b.backup_at ? 1 : 0,
  );
}
