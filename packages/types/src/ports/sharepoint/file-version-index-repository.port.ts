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
  /**
   * Newest captured historical version per file, as a Graph
   * `lastModifiedDateTime`, reconstructed by scanning the site's index
   * objects. Seeds the delta cursor's watermarks once when upgrading from a
   * version of Atlas that did not carry them; steady-state backups read the
   * cursor instead and never call this.
   */
  load_version_watermarks(ctx: TenantContext, site_id: string): Promise<Record<string, string>>;

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

  /**
   * Lists per-file version histories for a site, merged across index objects.
   * One scan answers every file: there is no per-file lookup, because with a
   * per-run layout that would rescan the whole prefix for a single file.
   */
  list_by_site(ctx: TenantContext, site_id: string): Promise<SharePointFileVersionIndex[]>;
}
