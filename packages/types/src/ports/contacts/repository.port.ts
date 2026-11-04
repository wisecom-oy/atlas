import type { ContactsDeltaCursor, ContactsSnapshotManifest } from '@/domain/contacts/manifest';
import type { TenantContext } from '@/ports/tenant/context.port';

export interface ContactsManifestRepository {
  /** Persists a snapshot manifest. */
  save(ctx: TenantContext, manifest: ContactsSnapshotManifest): Promise<void>;

  /** Finds a mailbox's manifest by snapshot ID. */
  find_by_snapshot(
    ctx: TenantContext,
    mailbox_id: string,
    snapshot_id: string,
  ): Promise<ContactsSnapshotManifest | undefined>;

  /** Returns the most recent manifest for a mailbox. */
  find_latest_by_mailbox(
    ctx: TenantContext,
    mailbox_id: string,
  ): Promise<ContactsSnapshotManifest | undefined>;

  /** Lists a mailbox's snapshot manifests, newest first. */
  list_snapshots_by_mailbox(
    ctx: TenantContext,
    mailbox_id: string,
  ): Promise<ContactsSnapshotManifest[]>;
}

export interface ContactsDeltaCursorRepository {
  /** Loads the persisted delta cursor for a mailbox. */
  load(ctx: TenantContext, mailbox_id: string): Promise<ContactsDeltaCursor | undefined>;

  /** Saves the delta cursor after a successful snapshot. */
  save(ctx: TenantContext, cursor: ContactsDeltaCursor): Promise<void>;
}
