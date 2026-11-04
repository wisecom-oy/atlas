import type { Container } from 'inversify';
import type {
  ContactsApi,
  ContactsBackupUseCase,
  ContactsCatalogUseCase,
  ContactsDeletionUseCase,
  ContactsRestoreUseCase,
  ContactsSdkRestoreOptions,
  ContactsVerificationUseCase,
  UserIdentityResolver,
} from '@wisecom/atlas-types';
import {
  CONTACTS_BACKUP_USE_CASE_TOKEN,
  CONTACTS_CATALOG_USE_CASE_TOKEN,
  CONTACTS_DELETION_USE_CASE_TOKEN,
  CONTACTS_RESTORE_USE_CASE_TOKEN,
  CONTACTS_VERIFICATION_USE_CASE_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
} from '@wisecom/atlas-types';
import { camelize } from '@wisecom/atlas-types/public/case-convert';
import { adapt_operation_options } from '@/operation-options';
import { resolve_owner_object_id } from '@/owner-resolution';

/** Builds the ContactsApi sub-namespace from the DI container. */
export function create_contacts_api(tenant_id: string, container: Container): ContactsApi {
  const backup = container.get<ContactsBackupUseCase>(CONTACTS_BACKUP_USE_CASE_TOKEN);
  const restore = container.get<ContactsRestoreUseCase>(CONTACTS_RESTORE_USE_CASE_TOKEN);
  const catalog = container.get<ContactsCatalogUseCase>(CONTACTS_CATALOG_USE_CASE_TOKEN);
  const verification = container.get<ContactsVerificationUseCase>(
    CONTACTS_VERIFICATION_USE_CASE_TOKEN,
  );
  const deletion = container.get<ContactsDeletionUseCase>(CONTACTS_DELETION_USE_CASE_TOKEN);
  const identity = container.get<UserIdentityResolver>(USER_IDENTITY_RESOLVER_TOKEN);

  const resolve_mailbox_id = (mailbox: string) =>
    resolve_owner_object_id(identity, tenant_id, mailbox);

  // An email target is resolved like the source mailbox, so a restore into another mailbox
  // addresses the same Entra object id that mailbox's backups are keyed by.
  const adapt_restore_options = async (options: ContactsSdkRestoreOptions) => {
    const adapted = adapt_operation_options(options);
    if (adapted === undefined) throw new Error('restore options are required');
    // Already cancelled: the service returns its interrupted result without touching Graph.
    if (adapted.target_mailbox_id === undefined || adapted.should_interrupt?.() === true) {
      return adapted;
    }
    return { ...adapted, target_mailbox_id: await resolve_mailbox_id(adapted.target_mailbox_id) };
  };

  return {
    async backup(mailbox, options) {
      const mailbox_id = await resolve_mailbox_id(mailbox);
      return camelize(
        await backup.backup_contacts(tenant_id, mailbox_id, adapt_operation_options(options)),
      );
    },
    async restore(mailbox, options) {
      const mailbox_id = await resolve_mailbox_id(mailbox);
      return camelize(
        await restore.restore_contacts(tenant_id, mailbox_id, await adapt_restore_options(options)),
      );
    },
    async verify(mailbox, snapshot_id, options) {
      const mailbox_id = await resolve_mailbox_id(mailbox);
      return camelize(
        await verification.verify_contacts_snapshot(
          tenant_id,
          mailbox_id,
          snapshot_id,
          adapt_operation_options(options),
        ),
      );
    },
    async listSnapshots(mailbox) {
      return camelize(
        await catalog.list_contacts_snapshots(tenant_id, await resolve_mailbox_id(mailbox)),
      );
    },
    async deleteMailboxData(mailbox) {
      return camelize(
        await deletion.delete_mailbox_data(tenant_id, await resolve_mailbox_id(mailbox)),
      );
    },
    async deleteSnapshot(mailbox, snapshot_id) {
      const mailbox_id = await resolve_mailbox_id(mailbox);
      return camelize(await deletion.delete_snapshot(tenant_id, mailbox_id, snapshot_id));
    },
  };
}
