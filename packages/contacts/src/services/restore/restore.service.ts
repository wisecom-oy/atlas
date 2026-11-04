import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import {
  begin_operation_progress,
  finish_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
import { inject, injectable } from 'inversify';
import type {
  ContactsConnector,
  ContactsManifestRepository,
  ContactsRestoreOptions,
  ContactsRestoreResult,
  ContactsRestoreUseCase,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  CONTACTS_CONNECTOR_TOKEN,
  CONTACTS_MANIFEST_REPOSITORY_TOKEN,
  NotFoundError,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';

import { restore_all_entries } from '@/services/restore/restore-entry-loop';
import { map_source_folders } from '@/services/restore/restore-folder-mapper';

/**
 * Restores a contacts snapshot into the source mailbox or a target mailbox. Existing contacts
 * are never overwritten: a contact whose name and email match one already in the folder is skipped.
 */
@injectable()
export class ContactsRestoreService implements ContactsRestoreUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(CONTACTS_CONNECTOR_TOKEN) private readonly _connector: ContactsConnector,
    @inject(CONTACTS_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: ContactsManifestRepository,
  ) {}

  /** Restores a snapshot into the source or a target mailbox without overwriting existing contacts. */
  async restore_contacts(
    tenant_id: string,
    mailbox_id: string,
    options: ContactsRestoreOptions,
  ): Promise<ContactsRestoreResult> {
    const source_id = normalize_owner_id(mailbox_id);
    const target_id = normalize_owner_id(options.target_mailbox_id ?? mailbox_id);
    if (begin_operation_progress(options, 'restore', 'contacts')) {
      finish_operation_progress(options, 'restore', 'contacts', 0, 0);
      return {
        snapshot_id: options.snapshot_id,
        contacts_restored: 0,
        contacts_skipped: 0,
        folders_created: 0,
        errors: [],
        interrupted: true,
      };
    }

    const tenant_ctx = await this._tenant_factory.create(tenant_id);
    try {
      return await this.run_restore(tenant_ctx, tenant_id, source_id, target_id, options);
    } finally {
      tenant_ctx.destroy();
    }
  }

  private async run_restore(
    ctx: TenantContext,
    tenant_id: string,
    source_id: string,
    target_id: string,
    options: ContactsRestoreOptions,
  ): Promise<ContactsRestoreResult> {
    const manifest = await this._manifests.find_by_snapshot(ctx, source_id, options.snapshot_id);
    if (manifest === undefined) {
      throw new NotFoundError(`No contacts snapshot ${options.snapshot_id} found for this mailbox`);
    }

    const mapping = await map_source_folders(
      this._connector,
      { tenant_id, mailbox_id: target_id },
      manifest.folders,
    );
    const loop = await restore_all_entries(
      { ctx, connector: this._connector, tenant_id, target_mailbox_id: target_id },
      manifest.entries,
      mapping.target_by_source,
      options,
    );
    const interrupted = finish_operation_progress(
      options,
      'restore',
      'contacts',
      loop.processed,
      manifest.entries.length,
      loop.interrupted,
    );

    return {
      snapshot_id: options.snapshot_id,
      contacts_restored: loop.restored,
      contacts_skipped: loop.skipped,
      folders_created: mapping.folders_created,
      errors: [...mapping.errors, ...loop.errors],
      interrupted,
    };
  }
}
