import { inject, injectable } from 'inversify';
import type {
  ContactsManifestRepository,
  HeldOwnerLease,
  OwnerLeasePort,
  QuarantinedObjectKind,
  QuarantineResult,
  QuarantineUseCase,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  CONTACTS_MANIFEST_REPOSITORY_TOKEN,
  OWNER_LEASE_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import {
  quarantine_unreadable_object,
  type QuarantineTarget,
} from '@wisecom/atlas-core/services/quarantine/stored-object-quarantine';
import { contacts_delta_cursor_key, contacts_manifest_key } from '@/services/shared/storage-keys';

/** A contacts snapshot manifest: `contacts/manifests/{mailbox}/{snapshot}.json`. */
const MANIFEST_KEY = /^contacts\/manifests\/([^/]+)\/([^/]+)\.json$/;

/** The mailbox segment of a key Atlas would write exactly as given, else undefined. */
function mailbox_of(storage_key: string): string | undefined {
  const match = MANIFEST_KEY.exec(storage_key);
  if (!match) return undefined;
  const [, mailbox = '', snapshot_id = ''] = match;
  try {
    return contacts_manifest_key(mailbox, snapshot_id) === storage_key ? mailbox : undefined;
  } catch {
    return undefined;
  }
}

/** Moves an unreadable contacts manifest aside (issue #631). */
@injectable()
export class ContactsQuarantineService implements QuarantineUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(CONTACTS_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: ContactsManifestRepository,
    @inject(OWNER_LEASE_TOKEN) private readonly _leases: OwnerLeasePort,
  ) {}

  /**
   * Moves the manifest at `storage_key` to `_quarantine/`, refusing one that reads cleanly, then
   * removes the mailbox's delta cursor and the moved manifest's summary row. The cursor's links may
   * describe the snapshot just moved aside; resuming them on top of an older manifest would drop
   * every change between the two, so the next backup reads every folder in full instead.
   */
  async quarantine_unreadable_object(
    tenant_id: string,
    storage_key: string,
  ): Promise<QuarantineResult> {
    const target: QuarantineTarget = {
      workload: 'Contacts',
      lease_workload: 'contacts',
      accepts: 'Contacts manifests',
      kind_of: (key): QuarantinedObjectKind | undefined =>
        mailbox_of(key) === undefined ? undefined : 'manifest',
      read: (ctx, key) => this._manifests.read_manifest_at(ctx, key),
      after_move: (ctx, key, lease) => this.after_manifest_moved(ctx, key, lease),
    };
    return quarantine_unreadable_object(
      this._tenant_factory,
      this._leases,
      target,
      tenant_id,
      storage_key,
    );
  }

  /** Drops the moved manifest's cursor, then its row from the mailbox's summary index (#727). */
  private async after_manifest_moved(
    ctx: TenantContext,
    storage_key: string,
    lease: HeldOwnerLease,
  ): Promise<void> {
    const mailbox = mailbox_of(storage_key);
    if (mailbox === undefined) return;
    await ctx.storage.delete(contacts_delta_cursor_key(mailbox));
    const [, , snapshot_id = ''] = MANIFEST_KEY.exec(storage_key) ?? [];
    await this._manifests.forget_snapshot_summary(ctx, mailbox, snapshot_id, lease);
  }
}
