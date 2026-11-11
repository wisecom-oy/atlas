import {
  find_latest_readable_full_snapshot,
  list_readable_full_snapshots,
  read_full_snapshot_manifest,
  type FullSnapshotManifestLayout,
} from '@wisecom/atlas-core/services/shared/full-snapshot-manifest-store';
import type {
  ContactsSnapshotManifest,
  ContactsManifestRepository,
  LatestReadableManifest,
  ReadableManifestListing,
  TenantContext,
} from '@wisecom/atlas-types';
import { injectable } from 'inversify';
import { contacts_manifest_key, contacts_manifest_prefix } from '@/services/shared/storage-keys';

const LAYOUT: FullSnapshotManifestLayout = {
  label: 'contacts manifest',
  manifest_key: contacts_manifest_key,
  manifest_prefix: contacts_manifest_prefix,
  snapshot_id_prefix: 'ct-snap-',
  list_fields: ['folders'],
  entry_id_field: 'contact_id',
};

/** Persists contacts snapshot manifests as encrypted JSON in S3. */
@injectable()
export class S3ContactsManifestRepository implements ContactsManifestRepository {
  /** Encrypts and stores one snapshot manifest. */
  async save(ctx: TenantContext, manifest: ContactsSnapshotManifest): Promise<void> {
    const key = contacts_manifest_key(manifest.mailbox_id, manifest.snapshot_id);
    await ctx.storage.put(key, ctx.encrypt(Buffer.from(JSON.stringify(manifest)), key));
  }

  /** Loads one snapshot's manifest, or undefined when it does not exist; raises when damaged. */
  async find_by_snapshot(
    ctx: TenantContext,
    mailbox_id: string,
    snapshot_id: string,
  ): Promise<ContactsSnapshotManifest | undefined> {
    const key = contacts_manifest_key(mailbox_id, snapshot_id);
    return read_full_snapshot_manifest<ContactsSnapshotManifest>(ctx, LAYOUT, key);
  }

  /** Loads the newest readable manifest of a mailbox, naming the newer damaged ones. */
  async find_latest_readable(
    ctx: TenantContext,
    mailbox_id: string,
  ): Promise<LatestReadableManifest<ContactsSnapshotManifest>> {
    return find_latest_readable_full_snapshot(ctx, LAYOUT, mailbox_id);
  }

  /** Lists every readable manifest of a mailbox, newest first, naming the damaged ones. */
  async list_readable_snapshots_by_mailbox(
    ctx: TenantContext,
    mailbox_id: string,
  ): Promise<ReadableManifestListing<ContactsSnapshotManifest>> {
    return list_readable_full_snapshots(ctx, LAYOUT, mailbox_id);
  }

  /** Reads the manifest at exactly this key; raises when it is damaged. */
  async read_manifest_at(
    ctx: TenantContext,
    storage_key: string,
  ): Promise<ContactsSnapshotManifest | undefined> {
    return read_full_snapshot_manifest<ContactsSnapshotManifest>(ctx, LAYOUT, storage_key);
  }
}
