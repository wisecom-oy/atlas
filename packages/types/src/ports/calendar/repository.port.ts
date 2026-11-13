import type { CalendarDeltaCursor, CalendarSnapshotManifest } from '@/domain/calendar/manifest';
import type { CalendarSnapshotSummary } from '@/domain/shared/snapshot-summary';
import type { HeldOwnerLease } from '@/ports/lease/owner-lease.port';
import type { TenantContext } from '@/ports/tenant/context.port';
import type {
  LatestReadableManifest,
  ReadableManifestListing,
  ReadableSnapshotSummaries,
} from '@/ports/storage/readable-listing.port';

export interface CalendarManifestRepository {
  /**
   * Persists a snapshot manifest, then records it in the mailbox's summary index. A backup passes
   * its lease, which is checked again right before the summary write.
   */
  save(
    ctx: TenantContext,
    manifest: CalendarSnapshotManifest,
    lease?: HeldOwnerLease,
  ): Promise<void>;

  /**
   * Drops a removed snapshot's row from the summary index; logs instead of failing. `lease` is
   * checked right before the write, and a lost one is raised.
   */
  forget_snapshot_summary(
    ctx: TenantContext,
    mailbox_id: string,
    snapshot_id: string,
    lease?: HeldOwnerLease,
  ): Promise<void>;

  /** Lists a mailbox's snapshots from its summary index, newest first (#727). */
  list_snapshot_summaries(
    ctx: TenantContext,
    mailbox_id: string,
  ): Promise<ReadableSnapshotSummaries<CalendarSnapshotSummary>>;

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
