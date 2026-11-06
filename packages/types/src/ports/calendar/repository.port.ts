import type { CalendarDeltaCursor, CalendarSnapshotManifest } from '@/domain/calendar/manifest';
import type { TenantContext } from '@/ports/tenant/context.port';

export interface CalendarManifestRepository {
  /** Persists a snapshot manifest. */
  save(ctx: TenantContext, manifest: CalendarSnapshotManifest): Promise<void>;

  /** Finds a mailbox's manifest by snapshot ID. */
  find_by_snapshot(
    ctx: TenantContext,
    mailbox_id: string,
    snapshot_id: string,
  ): Promise<CalendarSnapshotManifest | undefined>;

  /** Returns the most recent manifest for a mailbox. */
  find_latest_by_mailbox(
    ctx: TenantContext,
    mailbox_id: string,
  ): Promise<CalendarSnapshotManifest | undefined>;

  /** Lists a mailbox's snapshot manifests, newest first. */
  list_snapshots_by_mailbox(
    ctx: TenantContext,
    mailbox_id: string,
  ): Promise<CalendarSnapshotManifest[]>;
}

export interface CalendarDeltaCursorRepository {
  /** Loads the persisted delta cursor for a mailbox. */
  load(ctx: TenantContext, mailbox_id: string): Promise<CalendarDeltaCursor | undefined>;

  /** Saves the delta cursor after a successful run. */
  save(ctx: TenantContext, cursor: CalendarDeltaCursor): Promise<void>;
}
