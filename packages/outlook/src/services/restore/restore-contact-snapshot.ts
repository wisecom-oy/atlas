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
    const target = await deps.manifests.find_by_snapshot(ctx, snapshot_id);
    if (!target) throw new Error(`No manifest found for snapshot ${snapshot_id}`);
    const target_id = options.target_mailbox?.toLowerCase() ?? target.owner_id;
    await assert_mailbox_exists(deps.mailbox_connector, tenant_id, target_id);
    const all = await deps.manifests.list_all_manifests(ctx);
    const older = all.filter(
      (manifest) =>
        manifest.snapshot_id !== target.snapshot_id &&
        manifest.owner_id === target.owner_id &&
        new Date(manifest.created_at).getTime() <= new Date(target.created_at).getTime(),
    );
    const manifests = [target, ...older].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
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
