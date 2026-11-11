import { inject, injectable } from 'inversify';
import type {
  ContactsManifestRepository,
  QuarantineResult,
  QuarantineUseCase,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  CONTACTS_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import {
  quarantine_unreadable_object,
  type QuarantineTarget,
} from '@wisecom/atlas-core/services/quarantine/stored-object-quarantine';

/** A contacts snapshot manifest: `contacts/manifests/{mailbox}/{snapshot}.json`. */
const MANIFEST_KEY = /^contacts\/manifests\/[^/]+\/[^/]+\.json$/;

/** Moves an unreadable contacts manifest aside (issue #631). */
@injectable()
export class ContactsQuarantineService implements QuarantineUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(CONTACTS_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: ContactsManifestRepository,
  ) {}

  /** Moves the manifest at `storage_key` to `_quarantine/`, refusing one that reads cleanly. */
  async quarantine_unreadable_object(
    tenant_id: string,
    storage_key: string,
  ): Promise<QuarantineResult> {
    const target: QuarantineTarget = {
      workload: 'Contacts',
      accepts: 'Contacts manifests',
      kind_of: (key) => (MANIFEST_KEY.test(key) ? 'manifest' : undefined),
      read: (ctx, key) => this._manifests.read_manifest_at(ctx, key),
    };
    return quarantine_unreadable_object(this._tenant_factory, target, tenant_id, storage_key);
  }
}
