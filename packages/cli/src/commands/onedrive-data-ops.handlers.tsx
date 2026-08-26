import { Box } from 'ink';
import type { Container } from 'inversify';
import type { OneDriveDeletionUseCase, OneDriveStatusUseCase } from '@wisecom/atlas-types';
import {
  ONEDRIVE_DELETION_USE_CASE_TOKEN,
  ONEDRIVE_STATUS_USE_CASE_TOKEN,
} from '@wisecom/atlas-types';
import { Banner } from '@/ui/components/banner';
import { KeyValueList } from '@/ui/components/key-value-list';
import { render_static_view } from '@/ui/render';
import {
  confirm_deletion,
  print_delete_result,
  render_delete_banner,
} from '@/commands/deletion-presenter';
import { print_drive_status } from '@/commands/drive-status-presenter';
import {
  resolve_owner,
  resolve_tenant_id,
  type OneDriveTenantOptions,
} from '@/commands/onedrive-command.handlers';

export interface OneDriveDeleteOptions extends OneDriveTenantOptions {
  owner: string;
  snapshot?: string;
  yes?: boolean;
}

export interface OneDriveStatusCommandOptions extends OneDriveTenantOptions {
  owner: string;
}

/** Deletes one OneDrive snapshot, or every backup for an owner, after confirmation. */
export async function execute_onedrive_delete(
  container: Container,
  options: OneDriveDeleteOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  await render_delete_banner();

  const owner = await resolve_owner(container, tenant_id, options.owner);
  const description = options.snapshot
    ? `This will delete OneDrive snapshot ${options.snapshot} for ${owner.object_id} ` +
      `(data objects are retained for other snapshots)`
    : `This will delete all OneDrive data and manifests for ${owner.object_id}`;

  if (!(await confirm_deletion(description, options.yes))) return;

  const deletion = container.get<OneDriveDeletionUseCase>(ONEDRIVE_DELETION_USE_CASE_TOKEN);
  const result = options.snapshot
    ? await deletion.delete_snapshot(tenant_id, owner.object_id, options.snapshot)
    : await deletion.delete_owner_data(tenant_id, owner.object_id);
  print_delete_result(result);
}

/** Reports whether an owner's OneDrive backup is current, drive by drive. */
export async function execute_onedrive_status(
  container: Container,
  options: OneDriveStatusCommandOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const owner = await resolve_owner(container, tenant_id, options.owner);

  await render_static_view(
    <Box flexDirection="column">
      <Banner title="Atlas OneDrive Status" />
      <KeyValueList
        items={[
          { label: 'Tenant', value: tenant_id },
          { label: 'Owner', value: owner.object_id },
        ]}
      />
    </Box>,
  );

  const status = container.get<OneDriveStatusUseCase>(ONEDRIVE_STATUS_USE_CASE_TOKEN);
  const result = await status.check_onedrive_status(tenant_id, owner.object_id);
  await print_drive_status({
    scope_label: 'owner',
    item_label: 'Drive',
    last_backup_at: result.last_backup_at,
    last_snapshot_id: result.last_snapshot_id,
    is_up_to_date: result.is_up_to_date,
    total_pending_changes: result.total_pending_changes,
    items: result.drives,
  });
}
