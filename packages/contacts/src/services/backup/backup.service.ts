import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import {
  begin_operation_progress,
  finish_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
import { lock_run_writes } from '@wisecom/atlas-core/services/shared/run-object-lock';
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
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  CONTACTS_CONNECTOR_TOKEN,
  CONTACTS_DELTA_CURSOR_REPOSITORY_TOKEN,
  CONTACTS_MANIFEST_REPOSITORY_TOKEN,
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
  ) {}

  /** Backs up the mailbox's contacts; returns the new snapshot, or none when nothing changed. */
  async backup_contacts(
    tenant_id: string,
    mailbox_id: string,
    options: ContactsBackupOptions = {},
  ): Promise<ContactsBackupResult> {
    const mailbox = normalize_owner_id(mailbox_id);
    if (begin_operation_progress(options, 'backup', 'contacts')) {
      finish_operation_progress(options, 'backup', 'contacts', 0, 0);
      return {
        mailbox_id: mailbox,
        snapshot: undefined,
        interrupted: true,
        summary: empty_summary(),
      };
    }
    const tenant_ctx = await this._tenant_factory.create(tenant_id);
    try {
      const ctx = await lock_run_writes(tenant_ctx, options.object_lock_request);
      return await this.run_backup(ctx, tenant_id, mailbox, options);
    } finally {
      tenant_ctx.destroy();
    }
  }

  private async run_backup(
    ctx: TenantContext,
    tenant_id: string,
    mailbox_id: string,
    options: ContactsBackupOptions,
  ): Promise<ContactsBackupResult> {
    const cursor = await this._cursors.load(ctx, mailbox_id);
    const previous = await this._manifests.find_latest_by_mailbox(ctx, mailbox_id);
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
      loop_state(previous, cursor, options.force_full === true),
      options,
      reporter,
    );
    reporter.finish(folders.length);
    return this.persist_snapshot(ctx, { tenant_id, mailbox_id, folders, previous, loop, options });
  }

  /**
   * Writes the snapshot and cursor. An interrupted run writes neither: a partial run has moved some
   * folder links past changes no manifest records, so the next run must replay from the old links.
   */
  private async persist_snapshot(
    ctx: TenantContext,
    run: PersistInput,
  ): Promise<ContactsBackupResult> {
    const { tenant_id, mailbox_id, folders, previous, loop, options } = run;
    const created_at = new Date();
    const folder_records: ContactFolderRecord[] = folders.map((folder) => ({
      folder_id: folder.id,
      display_name: folder.display_name,
      path: folder.path,
    }));
    const counts = compare_entries(previous?.entries ?? [], loop.entries);
    const changed =
      counts.changed + counts.removed > 0 || folders_differ(previous?.folders, folder_records);
    const has_content = loop.entries.length > 0 || previous !== undefined;
    const writable = !loop.interrupted;
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
    if (snapshot !== undefined) await this._manifests.save(ctx, snapshot);
    if (writable) {
      const cursor: ContactsDeltaCursor = {
        mailbox_id,
        delta_link_by_folder: loop.delta_link_by_folder,
        updated_at: created_at.toISOString(),
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
      ...(snapshot === undefined
        ? {
            no_snapshot_reason:
              previous === undefined && loop.entries.length === 0 ? 'no_content' : 'no_changes',
          }
        : {}),
      errors: loop.errors,
      healthy: loop.errors.length === 0,
    };
    return { mailbox_id, snapshot, interrupted, summary };
  }
}

interface PersistInput {
  readonly tenant_id: string;
  readonly mailbox_id: string;
  readonly folders: readonly GraphContactFolder[];
  readonly previous: ContactsSnapshotManifest | undefined;
  readonly loop: FolderLoopOutcome;
  readonly options: ContactsBackupOptions;
}

/**
 * Decides which previous state a run may build on. Links are only trusted when the previous
 * manifest exists, since the links describe the state that manifest captured.
 */
function loop_state(
  previous: ContactsSnapshotManifest | undefined,
  cursor: ContactsDeltaCursor | undefined,
  force_full: boolean,
): FolderLoopState {
  const trusted = previous !== undefined && !force_full;
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
    no_snapshot_reason: 'no_changes',
    errors: [],
    healthy: true,
  };
}
