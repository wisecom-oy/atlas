import type {
  OneDriveFileVersionIndex,
  OneDriveVersionWatermark,
} from '../../domain/onedrive/manifest';
import type { TenantContext } from '../tenant/context.port';
import type { ReadableVersionIndexListing } from '@/ports/storage/readable-listing.port';

/**
 * Per-file version history for an owner, stored as one index object per backup
 * run instead of one object per file. A 20,000-file drive therefore costs one
 * PUT and one small object per run rather than tens of thousands of objects
 * each billed at the provider's minimum object size floor (issue #161).
 * Reads merge the per-run objects, including legacy per-file objects written
 * before the change, so history recorded by older versions stays visible.
 */
export interface OneDriveFileVersionIndexRepository {
  /**
   * Exact captured position per file, reconstructed by scanning the owner's
   * index objects. Seeds the delta cursor's watermarks once when upgrading
   * from a version of Atlas that did not carry them; steady-state backups read
   * the cursor instead and never call this.
   */
  load_version_watermarks(
    ctx: TenantContext,
    owner_id: string,
  ): Promise<Record<string, OneDriveVersionWatermark>>;

  /**
   * Writes the version rows captured during one backup run as a single index
   * object. Create-only by construction: snapshot ids are unique per run.
   * No-op when the run captured nothing, so quiet incremental runs write no
   * index object at all.
   */
  write_run_index(
    ctx: TenantContext,
    owner_id: string,
    snapshot_id: string,
    indexes: OneDriveFileVersionIndex[],
  ): Promise<void>;

  /**
   * Lists per-file version histories for an owner, merged across index
   * objects. One scan answers every file: there is no per-file lookup,
   * because with a per-run layout that would rescan the whole prefix for a
   * single file.
   *
   * An index object that fails to decrypt or parse is left out and its key is
   * returned in `unreadable_keys`, so a caller can tell a file with no history
   * from one whose history could not be read (issue #631).
   */
  list_readable_by_owner(
    ctx: TenantContext,
    owner_id: string,
  ): Promise<ReadableVersionIndexListing<OneDriveFileVersionIndex>>;

  /**
   * Reads the index object stored at exactly this key, as a listing would. Undefined when absent.
   *
   * @throws UnreadableContentError when it fails to decrypt or parse.
   */
  read_index_object_at(
    ctx: TenantContext,
    storage_key: string,
  ): Promise<OneDriveFileVersionIndex[] | undefined>;
}
