import { assert_mailbox_exists } from '@wisecom/atlas-core/services/shared/mailbox-assertions';
import type {
  ContactConnector,
  ContactsRestoreResult,
  MailboxConnector,
  ManifestRepository,
  RestoreOptions,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { restore_contact_chain } from '@/services/restore/contact-restore';
import { load_snapshot_chain } from '@/services/restore/snapshot-chain-loader';

export interface ContactRestoreDependencies {
  readonly tenant_factory: TenantContextFactory;
  readonly manifests: ManifestRepository;
  readonly mailbox_connector: MailboxConnector;
  readonly contact_connector: ContactConnector | undefined;
}

/** Loads the requested contact snapshot chain and writes its state to the target mailbox. */
export async function restore_contact_snapshot(
  deps: ContactRestoreDependencies,
  tenant_id: string,
  snapshot_id: string,
  options: Pick<RestoreOptions, 'target_mailbox' | 'should_interrupt'> = {},
): Promise<ContactsRestoreResult> {
  if (!deps.contact_connector) throw new Error('Contact connector is not configured');
  const ctx = await deps.tenant_factory.create(tenant_id);
  try {
    const manifests = await load_snapshot_chain(deps.manifests, ctx, snapshot_id);
    const target_id = options.target_mailbox?.toLowerCase() ?? manifests[0]!.owner_id;
    await assert_mailbox_exists(deps.mailbox_connector, tenant_id, target_id);
    const result = await restore_contact_chain(
      ctx,
      deps.contact_connector,
      tenant_id,
      target_id,
      manifests,
      options.should_interrupt,
    );
    return {
      snapshot_id,
      restored_count: result.restored,
      errors: result.errors,
      interrupted: result.interrupted,
    };
  } finally {
    ctx.destroy();
  }
}
