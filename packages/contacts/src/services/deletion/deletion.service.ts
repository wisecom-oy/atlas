import {
  delete_scopes,
  delete_snapshot_manifest,
} from '@wisecom/atlas-core/services/deletion/shared/prefix-deleter';
import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import { inject, injectable } from 'inversify';
import type {
  ContactsDeletionUseCase,
  DeletionResult,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { TENANT_CONTEXT_FACTORY_TOKEN } from '@wisecom/atlas-types';

import { contacts_manifest_key, contacts_mailbox_prefixes } from '@/services/shared/storage-keys';

/** Deletes a mailbox's contacts data or single snapshots, using a storage-only tenant context. */
@injectable()
export class ContactsDeletionService implements ContactsDeletionUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
  ) {}

  /** Deletes all backed-up contacts data for a mailbox. */
  async delete_mailbox_data(tenant_id: string, mailbox_id: string): Promise<DeletionResult> {
    const mailbox = normalize_owner_id(mailbox_id);
    const { storage } = await this._tenant_factory.create_storage_only(tenant_id);
    return delete_scopes(storage, contacts_mailbox_prefixes(mailbox));
  }

  /** Deletes one contacts snapshot manifest. Shared content objects are kept. */
  async delete_snapshot(
    tenant_id: string,
    mailbox_id: string,
    snapshot_id: string,
  ): Promise<DeletionResult> {
    const mailbox = normalize_owner_id(mailbox_id);
    const { storage } = await this._tenant_factory.create_storage_only(tenant_id);
    return delete_snapshot_manifest(
      storage,
      contacts_manifest_key(mailbox, snapshot_id),
      'Contacts',
      snapshot_id,
    );
  }
}
