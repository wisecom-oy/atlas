import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import { return_or_raise_partial } from '@wisecom/atlas-core/services/shared/unreadable-object-report';
import { inject, injectable } from 'inversify';
import type {
  ContactsCatalogUseCase,
  ContactsManifestRepository,
  ContactsSnapshotManifest,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  CONTACTS_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';

/** Lists a mailbox's contacts snapshots from the manifest repository. */
@injectable()
export class ContactsCatalogService implements ContactsCatalogUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(CONTACTS_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: ContactsManifestRepository,
  ) {}

  /**
   * Lists a mailbox's contacts snapshots, newest first.
   *
   * @throws UnreadableObjectsError naming each damaged manifest, with the readable snapshots in
   *   `partial_result` (issue #631).
   */
  async list_contacts_snapshots(
    tenant_id: string,
    mailbox_id: string,
  ): Promise<ContactsSnapshotManifest[]> {
    const mailbox = normalize_owner_id(mailbox_id);
    const tenant_ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const listing = await this._manifests.list_readable_snapshots_by_mailbox(tenant_ctx, mailbox);
      return return_or_raise_partial(listing.unreadable_keys, listing.manifests);
    } finally {
      tenant_ctx.destroy();
    }
  }
}
