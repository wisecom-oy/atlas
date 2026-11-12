import type {
  BackupSyncMode,
  HeldOwnerLease,
  MailboxDeltaCursorRepository,
  Manifest,
  ManifestRepository,
  Snapshot,
  TenantContext,
} from '@wisecom/atlas-types';
import {
  mark_snapshot_completed,
  resolve_saved_delta_links,
  resolve_sync_mode,
} from '@/services/backup/snapshot-manifest-builder';
import { resumable_delta_links } from '@/services/shared/resumable-delta-links';

export interface MailboxResumeState {
  /** The head manifest, for the stale-delta safeguard and the quiet-run decision. */
  readonly previous: Manifest | undefined;
  readonly saved_links: Record<string, string>;
  readonly previous_entry_count: number;
  readonly mode: BackupSyncMode;
  /** Manifests newer than `previous` that could not be read, reported with the run. */
  readonly unreadable_keys: string[];
}

/**
 * Reads where the last run left off.
 *
 * Delta links live in the cursor as of #370. A mailbox last backed up by an older release has
 * no cursor, so the head manifest's links are the fallback and the first run after the upgrade
 * resumes instead of re-enumerating the whole mailbox.
 *
 * A damaged head manifest no longer stops the mailbox's backups (issue #631). The newest readable
 * manifest stands in for it, which is safe because an Outlook manifest holds only its own run's
 * changes: nothing is built on the head's entries, and an older `total_objects` only makes the
 * stale-delta safeguard more willing to re-read.
 *
 * The cursor's links are resumed only while the cursor names the head as its snapshot. A cursor
 * left behind by a deleted or quarantined snapshot, or by `delete -m`, would skip every change that
 * snapshot recorded, so the run reads every folder in full instead (issues #703, #704).
 */
export async function resolve_resume_state(
  deps: MailboxRunPersistence,
  ctx: TenantContext,
  owner_id: string,
  force_full: boolean,
): Promise<MailboxResumeState> {
  if (force_full) {
    return {
      previous: undefined,
      saved_links: {},
      previous_entry_count: 0,
      mode: resolve_sync_mode(true, {}),
      unreadable_keys: [],
    };
  }

  const latest = await deps.manifests.find_latest_readable(ctx, owner_id);
  const previous = latest.manifest;
  const cursor = await deps.cursors.load(ctx, owner_id);
  const saved_links = resumable_delta_links(cursor, previous, resolve_saved_delta_links);

  return {
    previous,
    saved_links,
    previous_entry_count: previous?.total_objects ?? 0,
    mode: resolve_sync_mode(false, saved_links),
    unreadable_keys: latest.unreadable_keys,
  };
}

export interface MailboxRunPersistence {
  readonly manifests: ManifestRepository;
  readonly cursors: MailboxDeltaCursorRepository;
}

export interface MailboxRunOutcome {
  /** The snapshot to report: the one written, or the head a quiet run left in place. */
  readonly snapshot: Snapshot;
  /** False when the run captured nothing and the mailbox already had a snapshot. */
  readonly wrote_snapshot: boolean;
}

/**
 * Writes what a completed mailbox run produced: the snapshot manifest, then the delta cursor.
 *
 * A run that captured nothing has nothing to snapshot. Writing one anyway added a manifest
 * object per quiet run forever, only to carry the delta links, and a snapshot is immutable once
 * written so the head could not be rewritten instead. The links live in the cursor now, which
 * the run overwrites, the way the drive providers have always done it (issue #370). A run whose
 * only change was a deletion is not quiet: its removals exist only in its manifest, and the
 * cursor moves past them (issue #512).
 *
 * The cursor is saved after the manifest, never before. A cursor that lands first tells the next
 * run to skip changes no manifest recorded, which is what #339 was.
 *
 * Each write is preceded by a lease check, so a run that lost the mailbox to another operation
 * commits nothing (issue #623).
 */
export async function persist_mailbox_run(
  deps: MailboxRunPersistence,
  ctx: TenantContext,
  lease: HeldOwnerLease,
  manifest: Manifest,
  snapshot: Snapshot,
  previous: Manifest | undefined,
  entry_count: number,
): Promise<MailboxRunOutcome> {
  const captured_change = entry_count > 0 || (manifest.removed_object_ids?.length ?? 0) > 0;
  const wrote_snapshot = captured_change || previous === undefined;
  if (wrote_snapshot) {
    lease.assert_held();
    await deps.manifests.save(ctx, manifest, lease);
  }

  const head_snapshot_id = wrote_snapshot ? manifest.snapshot_id : previous.snapshot_id;
  lease.assert_held();
  await deps.cursors.save(ctx, {
    owner_id: manifest.owner_id,
    delta_links: manifest.delta_links,
    updated_at: new Date().toISOString(),
    snapshot_id: head_snapshot_id,
  });

  return {
    snapshot: mark_snapshot_completed(
      wrote_snapshot ? snapshot : { ...snapshot, id: head_snapshot_id },
      entry_count,
    ),
    wrote_snapshot,
  };
}
