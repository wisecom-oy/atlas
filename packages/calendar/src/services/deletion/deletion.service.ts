import {
  delete_scopes,
  delete_snapshot_manifest,
} from '@wisecom/atlas-core/services/deletion/shared/prefix-deleter';
import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import { inject, injectable } from 'inversify';
import type {
  CalendarDeletionUseCase,
  DeletionResult,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { TENANT_CONTEXT_FACTORY_TOKEN } from '@wisecom/atlas-types';

import { calendar_manifest_key, calendar_mailbox_prefixes } from '@/services/shared/storage-keys';

/** Deletes a mailbox's calendar data or single snapshots, using a storage-only tenant context. */
@injectable()
export class CalendarDeletionService implements CalendarDeletionUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
  ) {}

  /** Deletes all backed-up calendar data for a mailbox. */
  async delete_mailbox_data(tenant_id: string, mailbox_id: string): Promise<DeletionResult> {
    const mailbox = normalize_owner_id(mailbox_id);
    const { storage } = await this._tenant_factory.create_storage_only(tenant_id);
    return delete_scopes(storage, calendar_mailbox_prefixes(mailbox));
  }

  /** Deletes one calendar snapshot manifest. Shared content objects are kept. */
  async delete_snapshot(
    tenant_id: string,
    mailbox_id: string,
    snapshot_id: string,
  ): Promise<DeletionResult> {
    const mailbox = normalize_owner_id(mailbox_id);
    const { storage } = await this._tenant_factory.create_storage_only(tenant_id);
    return delete_snapshot_manifest(
      storage,
      calendar_manifest_key(mailbox, snapshot_id),
      'Calendar',
      snapshot_id,
    );
  }
}
