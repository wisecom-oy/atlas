import {
  find_latest_readable_full_snapshot,
  list_readable_full_snapshots,
  read_full_snapshot_manifest,
  type FullSnapshotManifestLayout,
} from '@wisecom/atlas-core/services/shared/full-snapshot-manifest-store';
import type {
  CalendarManifestRepository,
  CalendarSnapshotManifest,
  LatestReadableManifest,
  ReadableManifestListing,
  TenantContext,
} from '@wisecom/atlas-types';
import { injectable } from 'inversify';
import { calendar_manifest_key, calendar_manifest_prefix } from '@/services/shared/storage-keys';

const LAYOUT: FullSnapshotManifestLayout = {
  label: 'calendar manifest',
  manifest_key: calendar_manifest_key,
  manifest_prefix: calendar_manifest_prefix,
  snapshot_id_prefix: 'cal-snap-',
  list_fields: ['calendars'],
  entry_id_field: 'event_id',
};

/** Persists calendar snapshot manifests as encrypted JSON in S3. */
@injectable()
export class S3CalendarManifestRepository implements CalendarManifestRepository {
  /** Encrypts and stores one snapshot manifest. */
  async save(ctx: TenantContext, manifest: CalendarSnapshotManifest): Promise<void> {
    const key = calendar_manifest_key(manifest.mailbox_id, manifest.snapshot_id);
    await ctx.storage.put(key, ctx.encrypt(Buffer.from(JSON.stringify(manifest)), key));
  }

  /** Loads one snapshot's manifest, or undefined when it does not exist; raises when damaged. */
  async find_by_snapshot(
    ctx: TenantContext,
    mailbox_id: string,
    snapshot_id: string,
  ): Promise<CalendarSnapshotManifest | undefined> {
    const key = calendar_manifest_key(mailbox_id, snapshot_id);
    return read_full_snapshot_manifest<CalendarSnapshotManifest>(ctx, LAYOUT, key);
  }

  /** Loads the newest readable manifest of a mailbox, naming the newer damaged ones. */
  async find_latest_readable(
    ctx: TenantContext,
    mailbox_id: string,
  ): Promise<LatestReadableManifest<CalendarSnapshotManifest>> {
    return find_latest_readable_full_snapshot(ctx, LAYOUT, mailbox_id);
  }

  /** Lists every readable manifest of a mailbox, newest first, naming the damaged ones. */
  async list_readable_snapshots_by_mailbox(
    ctx: TenantContext,
    mailbox_id: string,
  ): Promise<ReadableManifestListing<CalendarSnapshotManifest>> {
    return list_readable_full_snapshots(ctx, LAYOUT, mailbox_id);
  }

  /** Reads the manifest at exactly this key; raises when it is damaged. */
  async read_manifest_at(
    ctx: TenantContext,
    storage_key: string,
  ): Promise<CalendarSnapshotManifest | undefined> {
    return read_full_snapshot_manifest<CalendarSnapshotManifest>(ctx, LAYOUT, storage_key);
  }
}
