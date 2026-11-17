import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import {
  find_latest_readable_full_snapshot,
  list_readable_full_snapshots,
  read_full_snapshot_manifest,
  save_full_snapshot_manifest,
} from '@wisecom/atlas-core/services/shared/full-snapshot-manifest-store';
import { forget_snapshot_summary_or_warn } from '@wisecom/atlas-core/services/shared/snapshot-summary-pruner';
import { list_snapshot_summaries } from '@wisecom/atlas-core/services/shared/snapshot-summary-reader';
import { record_snapshot_summary_or_warn } from '@wisecom/atlas-core/services/shared/snapshot-summary-writer';
import type {
  ContactsManifestRepository,
  ContactsSnapshotManifest,
  ContactsSnapshotSummary,
  HeldOwnerLease,
  LatestReadableManifest,
  ReadableManifestListing,
  ReadableSnapshotSummaries,
  TenantContext,
} from '@wisecom/atlas-types';
import { injectable } from 'inversify';
import { CONTACTS_MANIFEST_LAYOUT } from '@/adapters/contacts-manifest-layout';
import {
  CONTACTS_SUMMARY_LAYOUT,
  summarize_contacts_manifest,
} from '@/adapters/contacts-snapshot-summary-layout';
import { contacts_manifest_key } from '@/services/shared/storage-keys';

/** Persists contacts snapshot manifests as encrypted JSON in S3. */
@injectable()
export class S3ContactsManifestRepository implements ContactsManifestRepository {
  /**
   * Stores one snapshot manifest: create-only, checked as its reader checks it, and read back.
   * Then records its row in the mailbox's summary index. `lease` is checked right before that write.
   */
  async save(
    ctx: TenantContext,
    manifest: ContactsSnapshotManifest,
    lease?: HeldOwnerLease,
  ): Promise<void> {
    await save_full_snapshot_manifest(ctx, CONTACTS_MANIFEST_LAYOUT, manifest);
    const owner_id = normalize_owner_id(manifest.mailbox_id);
    const key = contacts_manifest_key(owner_id, manifest.snapshot_id);
    await record_snapshot_summary_or_warn(
      ctx,
      CONTACTS_SUMMARY_LAYOUT,
      owner_id,
      summarize_contacts_manifest(manifest, key),
      lease,
    );
  }

  /** Drops a removed snapshot's row from the mailbox's summary index; logs instead of failing. */
  async forget_snapshot_summary(
    ctx: TenantContext,
    mailbox_id: string,
    snapshot_id: string,
    lease?: HeldOwnerLease,
  ): Promise<void> {
    await forget_snapshot_summary_or_warn(
      ctx,
      CONTACTS_SUMMARY_LAYOUT,
      normalize_owner_id(mailbox_id),
      snapshot_id,
      lease,
    );
  }

  /** Lists a mailbox's snapshots from its summary index, decrypting only rowless manifests (#727). */
  async list_snapshot_summaries(
    ctx: TenantContext,
    mailbox_id: string,
  ): Promise<ReadableSnapshotSummaries<ContactsSnapshotSummary>> {
    return list_snapshot_summaries(ctx, CONTACTS_SUMMARY_LAYOUT, mailbox_id);
  }

  /** Loads one snapshot's manifest, or undefined when it does not exist; raises when damaged. */
  async find_by_snapshot(
    ctx: TenantContext,
    mailbox_id: string,
    snapshot_id: string,
  ): Promise<ContactsSnapshotManifest | undefined> {
    const key = contacts_manifest_key(mailbox_id, snapshot_id);
    return read_full_snapshot_manifest<ContactsSnapshotManifest>(
      ctx,
      CONTACTS_MANIFEST_LAYOUT,
      key,
    );
  }

  /** Loads the newest readable manifest of a mailbox, naming the newer damaged ones. */
  async find_latest_readable(
    ctx: TenantContext,
    mailbox_id: string,
  ): Promise<LatestReadableManifest<ContactsSnapshotManifest>> {
    return find_latest_readable_full_snapshot(ctx, CONTACTS_MANIFEST_LAYOUT, mailbox_id);
  }

  /** Lists every readable manifest of a mailbox, newest first, naming the damaged ones. */
  async list_readable_snapshots_by_mailbox(
    ctx: TenantContext,
    mailbox_id: string,
  ): Promise<ReadableManifestListing<ContactsSnapshotManifest>> {
    return list_readable_full_snapshots(ctx, CONTACTS_MANIFEST_LAYOUT, mailbox_id);
  }

  /** Reads the manifest at exactly this key; raises when it is damaged. */
  async read_manifest_at(
    ctx: TenantContext,
    storage_key: string,
  ): Promise<ContactsSnapshotManifest | undefined> {
    return read_full_snapshot_manifest<ContactsSnapshotManifest>(
      ctx,
      CONTACTS_MANIFEST_LAYOUT,
      storage_key,
    );
  }
}
