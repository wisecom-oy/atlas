import type { CalendarDeltaCursor, CalendarSnapshotManifest } from '@/domain/calendar/manifest';
import type { TenantContext } from '@/ports/tenant/context.port';
import type {
  LatestReadableManifest,
  ReadableManifestListing,
} from '@/ports/storage/readable-listing.port';

export interface CalendarManifestRepository {
  /** Persists a snapshot manifest. */
  save(ctx: TenantContext, manifest: CalendarSnapshotManifest): Promise<void>;

  /**
   * Finds a mailbox's manifest by snapshot ID.
   *
   * @throws UnreadableContentError when the snapshot's manifest is damaged.
   */
  find_by_snapshot(
    ctx: TenantContext,
    mailbox_id: string,
    snapshot_id: string,
  ): Promise<CalendarSnapshotManifest | undefined>;

  /** Returns the newest readable manifest for a mailbox, naming newer damaged ones. */
  find_latest_readable(
    ctx: TenantContext,
    mailbox_id: string,
  ): Promise<LatestReadableManifest<CalendarSnapshotManifest>>;

  /** Lists a mailbox's readable manifests, newest first, and the keys of the damaged ones. */
  list_readable_snapshots_by_mailbox(
    ctx: TenantContext,
    mailbox_id: string,
  ): Promise<ReadableManifestListing<CalendarSnapshotManifest>>;

  /**
   * Reads the manifest stored at exactly this key, as a listing would. Undefined when absent.
   *
   * @throws UnreadableContentError when it fails to decrypt, parse, or identify as its key.
   */
  read_manifest_at(
    ctx: TenantContext,
    storage_key: string,
  ): Promise<CalendarSnapshotManifest | undefined>;
}

export interface CalendarDeltaCursorRepository {
  /** Loads the persisted delta cursor for a mailbox. */
  load(ctx: TenantContext, mailbox_id: string): Promise<CalendarDeltaCursor | undefined>;

  /** Saves the delta cursor after a successful run. */
  save(ctx: TenantContext, cursor: CalendarDeltaCursor): Promise<void>;
}
