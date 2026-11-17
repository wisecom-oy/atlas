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
  CalendarManifestRepository,
  CalendarSnapshotManifest,
  CalendarSnapshotSummary,
  HeldOwnerLease,
  LatestReadableManifest,
  ReadableManifestListing,
  ReadableSnapshotSummaries,
  TenantContext,
} from '@wisecom/atlas-types';
import { injectable } from 'inversify';
import { CALENDAR_MANIFEST_LAYOUT } from '@/adapters/calendar-manifest-layout';
import {
  CALENDAR_SUMMARY_LAYOUT,
  summarize_calendar_manifest,
} from '@/adapters/calendar-snapshot-summary-layout';
import { calendar_manifest_key } from '@/services/shared/storage-keys';

/** Persists calendar snapshot manifests as encrypted JSON in S3. */
@injectable()
export class S3CalendarManifestRepository implements CalendarManifestRepository {
  /**
   * Stores one snapshot manifest: create-only, checked as its reader checks it, and read back.
   * Then records its row in the mailbox's summary index. `lease` is checked right before that write.
   */
  async save(
    ctx: TenantContext,
    manifest: CalendarSnapshotManifest,
    lease?: HeldOwnerLease,
  ): Promise<void> {
    await save_full_snapshot_manifest(ctx, CALENDAR_MANIFEST_LAYOUT, manifest);
    const owner_id = normalize_owner_id(manifest.mailbox_id);
    const key = calendar_manifest_key(owner_id, manifest.snapshot_id);
    await record_snapshot_summary_or_warn(
      ctx,
      CALENDAR_SUMMARY_LAYOUT,
      owner_id,
      summarize_calendar_manifest(manifest, key),
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
      CALENDAR_SUMMARY_LAYOUT,
      normalize_owner_id(mailbox_id),
      snapshot_id,
      lease,
    );
  }

  /** Lists a mailbox's snapshots from its summary index, decrypting only rowless manifests (#727). */
  async list_snapshot_summaries(
    ctx: TenantContext,
    mailbox_id: string,
  ): Promise<ReadableSnapshotSummaries<CalendarSnapshotSummary>> {
    return list_snapshot_summaries(ctx, CALENDAR_SUMMARY_LAYOUT, mailbox_id);
  }

  /** Loads one snapshot's manifest, or undefined when it does not exist; raises when damaged. */
  async find_by_snapshot(
    ctx: TenantContext,
    mailbox_id: string,
    snapshot_id: string,
  ): Promise<CalendarSnapshotManifest | undefined> {
    const key = calendar_manifest_key(mailbox_id, snapshot_id);
    return read_full_snapshot_manifest<CalendarSnapshotManifest>(
      ctx,
      CALENDAR_MANIFEST_LAYOUT,
      key,
    );
  }

  /** Loads the newest readable manifest of a mailbox, naming the newer damaged ones. */
  async find_latest_readable(
    ctx: TenantContext,
    mailbox_id: string,
  ): Promise<LatestReadableManifest<CalendarSnapshotManifest>> {
    return find_latest_readable_full_snapshot(ctx, CALENDAR_MANIFEST_LAYOUT, mailbox_id);
  }

  /** Lists every readable manifest of a mailbox, newest first, naming the damaged ones. */
  async list_readable_snapshots_by_mailbox(
    ctx: TenantContext,
    mailbox_id: string,
  ): Promise<ReadableManifestListing<CalendarSnapshotManifest>> {
    return list_readable_full_snapshots(ctx, CALENDAR_MANIFEST_LAYOUT, mailbox_id);
  }

  /** Reads the manifest at exactly this key; raises when it is damaged. */
  async read_manifest_at(
    ctx: TenantContext,
    storage_key: string,
  ): Promise<CalendarSnapshotManifest | undefined> {
    return read_full_snapshot_manifest<CalendarSnapshotManifest>(
      ctx,
      CALENDAR_MANIFEST_LAYOUT,
      storage_key,
    );
  }
}
