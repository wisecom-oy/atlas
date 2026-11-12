import {
  erase_leased_owner_scopes,
  run_owner_erasure,
  type LeasedDeletionPorts,
} from '@wisecom/atlas-core/services/deletion/shared/leased-owner-deletion';
import {
  delete_scopes,
  delete_snapshot_manifest,
  has_survivors,
  merge_deletion_results,
} from '@wisecom/atlas-core/services/deletion/shared/prefix-deleter';
import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import { inject, injectable } from 'inversify';
import type {
  CalendarDeletionUseCase,
  DeletionResult,
  OwnerLeasePort,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { OWNER_LEASE_TOKEN, TENANT_CONTEXT_FACTORY_TOKEN } from '@wisecom/atlas-types';

import {
  calendar_delta_cursor_key,
  calendar_manifest_key,
  calendar_mailbox_prefixes,
} from '@/services/shared/storage-keys';

/**
 * Deletes a mailbox's calendar data or single snapshots, using a storage-only tenant context. Each
 * deletion holds the mailbox's calendar lease, so it is refused with `OwnerBusyError` while a backup
 * of the mailbox runs (issue #623).
 */
@injectable()
export class CalendarDeletionService implements CalendarDeletionUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(OWNER_LEASE_TOKEN) private readonly _leases: OwnerLeasePort,
  ) {}

  private get _ports(): LeasedDeletionPorts {
    return { tenant_factory: this._tenant_factory, leases: this._leases };
  }

  /** Deletes all backed-up calendar data for a mailbox. */
  async delete_mailbox_data(tenant_id: string, mailbox_id: string): Promise<DeletionResult> {
    const mailbox = normalize_owner_id(mailbox_id);
    const owner = { workload: 'calendar', owner_id: mailbox } as const;
    return run_owner_erasure(this._ports, tenant_id, owner, (storage, lease) =>
      erase_leased_owner_scopes(storage, lease, calendar_mailbox_prefixes(mailbox)),
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
    const owner = { workload: 'calendar', owner_id: mailbox } as const;
    return run_owner_erasure(this._ports, tenant_id, owner, async (storage, lease) => {
      lease.assert_held();
      const manifest_result = await delete_snapshot_manifest(
        storage,
        calendar_manifest_key(mailbox, snapshot_id),
        'Calendar',
        snapshot_id,
      );
      if (has_survivors(manifest_result)) return manifest_result;
      const cursor_result = await delete_scopes(storage, [calendar_delta_cursor_key(mailbox)]);
      return merge_deletion_results(manifest_result, cursor_result);
    });
  }
}
