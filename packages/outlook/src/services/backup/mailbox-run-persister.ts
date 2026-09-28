import type {
  BackupSyncMode,
  MailboxDeltaCursorRepository,
  Manifest,
  ManifestRepository,
  Snapshot,
  TenantContext,
} from '@wisecom/atlas-types';
import type {
  ContactFolder,
  FailedItemLedger,
  MailboxConfigRef,
  MailboxDeltaCursor,
} from '@wisecom/atlas-types';
import {
  mark_snapshot_completed,
  resolve_saved_delta_links,
  resolve_sync_mode,
} from '@/services/backup/snapshot-manifest-builder';

export interface MailboxResumeState {
  /** The head manifest, for the stale-delta safeguard and the quiet-run decision. */
  readonly previous: Manifest | undefined;
  readonly saved_links: Record<string, string>;
  readonly previous_entry_count: number;
  readonly mode: BackupSyncMode;
  readonly contact_links: Record<string, string>;
  readonly contact_folders: ContactFolder[];
  readonly failed_contacts: FailedItemLedger;
  readonly mailbox_config: MailboxConfigRef | undefined;
}

/**
 * Reads where the last run left off.
 *
 * Delta links live in the cursor as of #370. A mailbox last backed up by an older release has
 * no cursor, so the head manifest's links are the fallback and the first run after the upgrade
 * resumes instead of re-enumerating the whole mailbox.
 */
export async function resolve_resume_state(
  deps: MailboxRunPersistence,
  ctx: TenantContext,
  owner_id: string,
  force_full: boolean,
): Promise<MailboxResumeState> {
  const previous = await deps.manifests.find_latest_by_owner(ctx, owner_id);
  const cursor = await deps.cursors.load(ctx, owner_id);
  const saved_links = force_full
    ? {}
    : (cursor?.delta_links ?? resolve_saved_delta_links(previous));
  return {
    previous: force_full ? undefined : previous,
    saved_links,
    previous_entry_count: force_full ? 0 : (previous?.total_objects ?? 0),
    mode: resolve_sync_mode(force_full, saved_links),
    contact_links: cursor?.contact_delta_links ?? previous?.contact_delta_links ?? {},
    contact_folders: cursor?.contact_folders ?? previous?.contact_folders ?? [],
    failed_contacts: cursor?.failed_contacts ?? {},
    mailbox_config: cursor?.mailbox_config ?? previous?.mailbox_config,
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
 * the run overwrites, the way the drive providers have always done it (issue #370).
 *
 * The cursor is saved after the manifest, never before. A cursor that lands first tells the next
 * run to skip changes no manifest recorded, which is what #339 was.
 */
export async function persist_mailbox_run(
  deps: MailboxRunPersistence,
  ctx: TenantContext,
  manifest: Manifest,
  snapshot: Snapshot,
  previous: Manifest | undefined,
  entry_count: number,
  cursor_state?: Pick<
    MailboxDeltaCursor,
    'contact_delta_links' | 'contact_folders' | 'failed_contacts' | 'mailbox_config'
  >,
  has_non_mail_changes = false,
): Promise<MailboxRunOutcome> {
  const wrote_snapshot = entry_count > 0 || has_non_mail_changes || previous === undefined;
  if (wrote_snapshot) await deps.manifests.save(ctx, manifest);

  await deps.cursors.save(ctx, {
    owner_id: manifest.owner_id,
    delta_links: manifest.delta_links,
    ...cursor_state,
    updated_at: new Date().toISOString(),
  });

  return {
    snapshot: mark_snapshot_completed(
      wrote_snapshot ? snapshot : { ...snapshot, id: previous.snapshot_id },
      entry_count,
    ),
    wrote_snapshot,
  };
}
