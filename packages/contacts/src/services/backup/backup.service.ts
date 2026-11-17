import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import {
  begin_operation_progress,
  finish_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
import { attach_run_retention } from '@wisecom/atlas-core/services/shared/run-object-lock';
import { run_cancellable } from '@wisecom/atlas-core/services/shared/cancellable-run';
import { run_with_owner_lease } from '@wisecom/atlas-core/services/lease/run-with-owner-lease';
import { cursor_describes_head } from '@wisecom/atlas-core/services/shared/delta-cursor-binding';
import { inject, injectable } from 'inversify';
import type {
  ContactFolderRecord,
  ContactsBackupOptions,
  ContactsBackupResult,
  ContactsBackupSummary,
  ContactsBackupUseCase,
  ContactsConnector,
  ContactsDeltaCursor,
  ContactsDeltaCursorRepository,
  ContactsManifestRepository,
  ContactsSnapshotManifest,
  GraphContactFolder,
  HeldOwnerLease,
  OwnerLeasePort,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  CONTACTS_CONNECTOR_TOKEN,
  CONTACTS_DELTA_CURSOR_REPOSITORY_TOKEN,
  CONTACTS_MANIFEST_REPOSITORY_TOKEN,
  OWNER_LEASE_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { resolve_backup_progress } from '@/services/backup/backup-progress';
import {
  sync_all_folders,
  type FolderLoopOutcome,
  type FolderLoopState,
} from '@/services/backup/backup-folder-loop';
import {
  build_snapshot_manifest,
  compare_entries,
  folders_differ,
  new_snapshot_id,
} from '@/services/backup/backup-snapshot';

/**
 * Backs up one mailbox's contacts as a full snapshot manifest. Each folder keeps its own
 * delta link; a run that changes nothing writes no snapshot but still advances the cursor.
 */
@injectable()
export class ContactsBackupService implements ContactsBackupUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(CONTACTS_CONNECTOR_TOKEN) private readonly _connector: ContactsConnector,
    @inject(CONTACTS_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: ContactsManifestRepository,
    @inject(CONTACTS_DELTA_CURSOR_REPOSITORY_TOKEN)
    private readonly _cursors: ContactsDeltaCursorRepository,
    @inject(OWNER_LEASE_TOKEN) private readonly _leases: OwnerLeasePort,
  ) {}

  /**
   * Backs up the mailbox's contacts; returns the new snapshot, or none when nothing changed. The
   * run holds the mailbox's contacts lease from before it reads the cursor until it ends.
   *
   * @throws OwnerBusyError when another operation holds the mailbox's contacts backup.
   */
  async backup_contacts(
    tenant_id: string,
    mailbox_id: string,
    options: ContactsBackupOptions = {},
  ): Promise<ContactsBackupResult> {
    const mailbox = normalize_owner_id(mailbox_id);
    const cancelled = (): ContactsBackupResult => {
      finish_operation_progress(options, 'backup', 'contacts', 0, 0, true);
      return {
        mailbox_id: mailbox,
        snapshot: undefined,
        interrupted: true,
        summary: empty_summary(),
      };
    };
    if (begin_operation_progress(options, 'backup', 'contacts')) return cancelled();
    const tenant_ctx = await this._tenant_factory.create(tenant_id);
    try {
      return await run_with_owner_lease(
        this._leases,
        tenant_ctx,
        { workload: 'contacts', owner_id: mailbox, operation: 'backup' },
        async (lease) => {
          const ctx = await attach_run_retention(tenant_ctx, options.object_lock_request);
          return run_cancellable(
            options,
            () => this.run_backup(ctx, lease, tenant_id, mailbox, options),
            cancelled,
          );
        },
      );
    } finally {
      tenant_ctx.destroy();
    }
  }

  private async run_backup(
    ctx: TenantContext,
    lease: HeldOwnerLease,
    tenant_id: string,
    mailbox_id: string,
    options: ContactsBackupOptions,
  ): Promise<ContactsBackupResult> {
    const cursor = await this._cursors.load(ctx, mailbox_id);
    const latest = await this._manifests.find_latest_readable(ctx, mailbox_id);
    const previous = latest.manifest;
    const head_unreadable = latest.unreadable_keys.length > 0;
    const folders = await this._connector.list_contact_folders(tenant_id, mailbox_id);
    const reporter = resolve_backup_progress(options, folders);
    const loop = await sync_all_folders(
      {
        ctx,
        connector: this._connector,
        tenant_id,
        mailbox_id,
        should_interrupt: () =>
          options.should_interrupt?.() === true || options.abort_signal?.aborted === true,
      },
      folders,
      loop_state(previous, cursor, options.force_full === true || head_unreadable),
      options,
      reporter,
    );
    reporter.finish(folders.length);
    return this.persist_snapshot(ctx, {
      lease,
      tenant_id,
      mailbox_id,
      folders,
      previous,
      unreadable_keys: latest.unreadable_keys,
      loop,
      options,
    });
  }

  /**
   * Writes the snapshot and cursor. An interrupted run writes neither: a partial run has moved some
   * folder links past changes no manifest records, so the next run must replay from the old links.
   *
   * A run built on an older manifest because the newest could not be read writes neither when any
   * folder failed. A failed folder keeps its entries from that older manifest, so the snapshot would
   * roll it back past the unreadable one: items added since missing, deleted ones back. Without a
   * cursor the next run reads every folder in full again (issue #631).
   *
   * Each write is preceded by a lease check, so a run that lost the mailbox to another operation
   * commits nothing (issue #623).
   */
  private async persist_snapshot(
    ctx: TenantContext,
    run: PersistInput,
  ): Promise<ContactsBackupResult> {
    const { tenant_id, mailbox_id, folders, previous, unreadable_keys, loop, options } = run;
    const created_at = new Date();
    const folder_records: ContactFolderRecord[] = folders.map((folder) => ({
      folder_id: folder.id,
      display_name: folder.display_name,
      path: folder.path,
    }));
    const counts = compare_entries(previous?.entries ?? [], loop.entries);
    const changed =
      counts.changed + counts.removed > 0 ||
      folders_differ(previous?.folders, folder_records) ||
      unreadable_keys.length > 0;
    const has_content =
      loop.entries.length > 0 || previous !== undefined || unreadable_keys.length > 0;
    const writable =
      !loop.interrupted && (unreadable_keys.length === 0 || loop.errors.length === 0);
    const snapshot =
      writable && changed && has_content
        ? build_snapshot_manifest({
            tenant_id,
            mailbox_id,
            snapshot_id: new_snapshot_id(created_at.getTime()),
            created_at,
            folders: folder_records,
            entries: loop.entries,
          })
        : undefined;
    if (snapshot !== undefined) {
      run.lease.assert_held();
      await this._manifests.save(ctx, snapshot, run.lease);
    }
    if (writable) {
      run.lease.assert_held();
      const head_snapshot_id = snapshot?.snapshot_id ?? previous?.snapshot_id;
      const cursor: ContactsDeltaCursor = {
        mailbox_id,
        delta_link_by_folder: loop.delta_link_by_folder,
        updated_at: created_at.toISOString(),
        ...(head_snapshot_id !== undefined ? { snapshot_id: head_snapshot_id } : {}),
      };
      await this._cursors.save(ctx, cursor);
    }
    const interrupted = finish_operation_progress(
      options,
      'backup',
      'contacts',
      folders.length,
      folders.length,
      loop.interrupted,
    );
    const summary: ContactsBackupSummary = {
      folders_scanned: folders.length,
      contacts_changed: counts.changed,
      contacts_removed: counts.removed,
      objects_stored: loop.objects_stored,
      snapshot_created: snapshot !== undefined,
      ...(snapshot === undefined && loop.errors.length === 0 && !loop.interrupted
        ? {
            no_snapshot_reason:
              previous === undefined && loop.entries.length === 0 ? 'no_content' : 'no_changes',
          }
        : {}),
      errors: loop.errors,
      healthy: loop.errors.length === 0,
      ...(unreadable_keys.length > 0 ? { unreadable_keys: [...unreadable_keys] } : {}),
    };
    return { mailbox_id, snapshot, interrupted, summary };
  }
}

interface PersistInput {
  readonly lease: HeldOwnerLease;
  readonly tenant_id: string;
  readonly mailbox_id: string;
  readonly folders: readonly GraphContactFolder[];
  readonly previous: ContactsSnapshotManifest | undefined;
  /** Manifests newer than `previous` that could not be read; they force a full read and a snapshot. */
  readonly unreadable_keys: readonly string[];
  readonly loop: FolderLoopOutcome;
  readonly options: ContactsBackupOptions;
}

/**
 * Decides which previous state a run may build on. Links are only trusted while the cursor still
 * describes the previous manifest, since the links describe the state that manifest captured. A
 * cursor bound to a snapshot that was since deleted would skip the changes only that snapshot
 * recorded (issue #704). A damaged newer
 * manifest counts as untrusted too: the cursor's links describe the state it captured, which is
 * unreadable, so building on an older manifest with those links would drop every change between
 * the two. The run reads every folder in full instead and writes a fresh snapshot (issue #631).
 */
function loop_state(
  previous: ContactsSnapshotManifest | undefined,
  cursor: ContactsDeltaCursor | undefined,
  read_in_full: boolean,
): FolderLoopState {
  const trusted =
    !read_in_full && cursor_describes_head(cursor?.snapshot_id, previous?.snapshot_id);
  const links = trusted ? (cursor?.delta_link_by_folder ?? {}) : {};
  return {
    previous_entries: previous?.entries ?? [],
    read_links: links,
    kept_links: trusted ? links : {},
  };
}

function empty_summary(): ContactsBackupSummary {
  return {
    folders_scanned: 0,
    contacts_changed: 0,
    contacts_removed: 0,
    objects_stored: 0,
    snapshot_created: false,
    errors: [],
    healthy: true,
  };
}
