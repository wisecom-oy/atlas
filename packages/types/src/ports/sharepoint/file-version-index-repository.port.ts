import type { SharePointFileVersionIndex } from '../../domain/sharepoint-manifest';
import type { TenantContext } from '../tenant/context.port';

/**
 * Per-file version history for a site, stored as one index object per backup
 * run instead of one object per file. A 20,000-file site therefore costs one
 * PUT and one small object per run rather than tens of thousands of objects
 * each billed at the provider's minimum object size floor (issue #161).
 * Reads merge the per-run objects, including legacy per-file objects written
 * before the change, so history recorded by older versions stays visible.
 */
export interface SharePointFileVersionIndexRepository {
  /** Version ids already recorded per file id across the site's index objects, for dedup before downloading versions again. */
  load_known_version_ids(ctx: TenantContext, site_id: string): Promise<Map<string, Set<string>>>;

  /**
   * Writes the version rows captured during one backup run as a single index
   * object. Create-only by construction: snapshot ids are unique per run.
   * No-op when the run captured nothing, so quiet incremental runs write no
   * index object at all.
   */
  write_run_index(
    ctx: TenantContext,
    site_id: string,
    snapshot_id: string,
    indexes: SharePointFileVersionIndex[],
  ): Promise<void>;

  /** Retrieves the version history for a specific file, merged across index objects. */
  find_by_file_id(
    ctx: TenantContext,
    site_id: string,
    file_id: string,
  ): Promise<SharePointFileVersionIndex | undefined>;

  /** Lists per-file version histories for a site, merged across index objects. */
  list_by_site(ctx: TenantContext, site_id: string): Promise<SharePointFileVersionIndex[]>;
}
