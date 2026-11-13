import type { Container } from 'inversify';
import { Box } from 'ink';
import { read_listing, report_unreadable_keys } from '@/command-unreadable-objects';
import { logger } from '@wisecom/atlas-core';
import type { ContactsCatalogUseCase, ContactsDeletionUseCase } from '@wisecom/atlas-types';
import {
  CONTACTS_CATALOG_USE_CASE_TOKEN,
  CONTACTS_DELETION_USE_CASE_TOKEN,
} from '@wisecom/atlas-types';
import { banner_title } from '@/ui/banner-title';
import { Banner } from '@/ui/components/banner';
import { DataTable, type TableColumn } from '@/ui/components/data-table';
import { render_static_view } from '@/ui/render';
import {
  confirm_deletion,
  print_delete_result,
  render_delete_banner,
} from '@/commands/shared/deletion-presenter';
import { resolve_owner, resolve_tenant_id } from '@/commands/onedrive/command.handlers';
import type { ContactsTenantOptions } from '@/commands/contacts/command.handlers';

export interface ContactsListCommandOptions extends ContactsTenantOptions {
  mailbox: string;
}

export interface ContactsDeleteCommandOptions extends ContactsTenantOptions {
  mailbox: string;
  snapshot?: string;
  yes?: boolean;
}

interface SnapshotRow {
  snapshot_id: string;
  created_at: string;
  total_contacts: number;
}

const snapshot_columns: TableColumn<SnapshotRow>[] = [
  { key: 'snapshot_id', header: 'Snapshot' },
  { key: 'created_at', header: 'Created' },
  { key: 'total_contacts', header: 'Contacts', align: 'right' },
];

/** Lists a mailbox's contacts snapshots, newest first. */
export async function execute_contacts_list(
  container: Container,
  options: ContactsListCommandOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const mailbox = await resolve_owner(container, tenant_id, options.mailbox);
  const catalog = container.get<ContactsCatalogUseCase>(CONTACTS_CATALOG_USE_CASE_TOKEN);
  const listing = await read_listing(() =>
    catalog.list_contacts_snapshot_summaries(tenant_id, mailbox.object_id),
  );
  const snapshots = listing.result;
  report_unreadable_keys(listing.unreadable_keys);

  await render_static_view(
    <Box flexDirection="column">
      <Banner title={banner_title('contacts', 'Snapshots')} />
    </Box>,
  );
  if (snapshots.length === 0) {
    logger.info('No contacts snapshots found.');
    return;
  }
  const rows: SnapshotRow[] = snapshots.map((snap) => ({
    snapshot_id: snap.snapshot_id,
    created_at: snap.created_at.toISOString(),
    total_contacts: snap.total_contacts,
  }));
  await render_static_view(<DataTable columns={snapshot_columns} rows={rows} />);
}

/** Deletes one contacts snapshot, or every contacts backup for a mailbox, after confirmation. */
export async function execute_contacts_delete(
  container: Container,
  options: ContactsDeleteCommandOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  await render_delete_banner();

  const mailbox = await resolve_owner(container, tenant_id, options.mailbox);
  const description = options.snapshot
    ? `This will delete contacts snapshot ${options.snapshot} for ${mailbox.object_id} ` +
      `(data objects are retained for other snapshots)`
    : `This will delete all contacts data and manifests for ${mailbox.object_id}`;

  if (!(await confirm_deletion(description, options.yes))) return;

  const deletion = container.get<ContactsDeletionUseCase>(CONTACTS_DELETION_USE_CASE_TOKEN);
  const result = options.snapshot
    ? await deletion.delete_snapshot(tenant_id, mailbox.object_id, options.snapshot)
    : await deletion.delete_mailbox_data(tenant_id, mailbox.object_id);
  print_delete_result(result);
}
