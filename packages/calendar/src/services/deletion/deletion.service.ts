import {
  delete_scopes,
  delete_snapshot_manifest,
  has_survivors,
  merge_deletion_results,
} from '@wisecom/atlas-core/services/deletion/shared/prefix-deleter';
import {
  delete_under_owner_lease,
  type LeasedDeletionDeps,
} from '@wisecom/atlas-core/services/deletion/shared/leased-deletion';
import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import { inject, injectable } from 'inversify';
import type {
  CalendarDeletionUseCase,
  DeletionResult,
  ObjectStorage,
  OwnerLeases,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { OWNER_LEASES_TOKEN, TENANT_CONTEXT_FACTORY_TOKEN } from '@wisecom/atlas-types';

import {
  calendar_delta_cursor_key,
  calendar_manifest_key,
  calendar_mailbox_prefixes,
} from '@/services/shared/storage-keys';

/**
 * Deletes a mailbox's calendar data or single snapshots, using a storage-only tenant context, while
 * holding the mailbox's calendar lease.
 */
@injectable()
export class CalendarDeletionService implements CalendarDeletionUseCase {
  private readonly _deps: LeasedDeletionDeps;

  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) tenant_factory: TenantContextFactory,
    @inject(OWNER_LEASES_TOKEN) leases: OwnerLeases,
  ) {
    this._deps = { tenant_factory, leases };
  }

  /** Deletes all backed-up calendar data for a mailbox. */
  async delete_mailbox_data(tenant_id: string, mailbox_id: string): Promise<DeletionResult> {
    const mailbox = normalize_owner_id(mailbox_id);
    return delete_under_owner_lease(this._deps, tenant_id, 'calendar', mailbox, (storage) =>
      delete_scopes(storage, calendar_mailbox_prefixes(mailbox)),
    );
  }

  /**
   * Deletes one calendar snapshot manifest, then the mailbox's delta cursor. Shared content objects
   * are kept. The cursor may point past the deleted run, so the next backup reads every calendar in
   * full rather than skip what only that snapshot recorded (issue #704). A manifest Object Lock
   * retains is still the head, so its cursor stays too.
   */
  async delete_snapshot(
    tenant_id: string,
    mailbox_id: string,
    snapshot_id: string,
  ): Promise<DeletionResult> {
    const mailbox = normalize_owner_id(mailbox_id);
    return delete_under_owner_lease(this._deps, tenant_id, 'calendar', mailbox, (storage) =>
      delete_snapshot_and_cursor(storage, mailbox, snapshot_id),
    );
  }
}

/** Deletes the snapshot manifest, then the cursor once the manifest is gone. */
async function delete_snapshot_and_cursor(
  storage: ObjectStorage,
  mailbox: string,
  snapshot_id: string,
): Promise<DeletionResult> {
  const manifest_result = await delete_snapshot_manifest(
    storage,
    calendar_manifest_key(mailbox, snapshot_id),
    'Calendar',
    snapshot_id,
  );
  if (has_survivors(manifest_result)) return manifest_result;
  const cursor_result = await delete_scopes(storage, [calendar_delta_cursor_key(mailbox)]);
  return merge_deletion_results(manifest_result, cursor_result);
}
