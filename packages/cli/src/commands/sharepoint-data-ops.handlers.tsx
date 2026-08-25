import { Box } from 'ink';
import type { Container } from 'inversify';
import type { SharePointDeletionUseCase, SharePointStatusUseCase } from '@wisecom/atlas-types';
import {
  SHAREPOINT_DELETION_USE_CASE_TOKEN,
  SHAREPOINT_STATUS_USE_CASE_TOKEN,
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
  resolve_site_id,
  resolve_tenant_id,
  type SharePointTenantOptions,
} from '@/commands/sharepoint-command.handlers';

export interface SharePointDeleteOptions extends SharePointTenantOptions {
  site: string;
  snapshot?: string;
  yes?: boolean;
}

export interface SharePointStatusCommandOptions extends SharePointTenantOptions {
  site: string;
}

/** Deletes one SharePoint snapshot, or every backup for a site, after confirmation. */
export async function execute_sharepoint_delete(
  container: Container,
  options: SharePointDeleteOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  await render_delete_banner();

  const site_id = await resolve_site_id(container, tenant_id, options.site);
  const description = options.snapshot
    ? `This will delete SharePoint snapshot ${options.snapshot} for ${site_id} ` +
      `(data objects are retained for other snapshots)`
    : `This will delete all SharePoint data and manifests for ${site_id}`;

  if (!(await confirm_deletion(description, options.yes))) return;

  const deletion = container.get<SharePointDeletionUseCase>(SHAREPOINT_DELETION_USE_CASE_TOKEN);
  const result = options.snapshot
    ? await deletion.delete_snapshot(tenant_id, site_id, options.snapshot)
    : await deletion.delete_site_data(tenant_id, site_id);
  print_delete_result(result);
}

/** Reports whether a site's SharePoint backup is current, library by library. */
export async function execute_sharepoint_status(
  container: Container,
  options: SharePointStatusCommandOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const site_id = await resolve_site_id(container, tenant_id, options.site);

  await render_static_view(
    <Box flexDirection="column">
      <Banner title="Atlas SharePoint Status" />
      <KeyValueList
        items={[
          { label: 'Tenant', value: tenant_id },
          { label: 'Site', value: site_id },
        ]}
      />
    </Box>,
  );

  const status = container.get<SharePointStatusUseCase>(SHAREPOINT_STATUS_USE_CASE_TOKEN);
  const result = await status.check_sharepoint_status(tenant_id, site_id);
  await print_drive_status({
    scope_label: 'site',
    item_label: 'Library',
    last_backup_at: result.last_backup_at,
    last_snapshot_id: result.last_snapshot_id,
    is_up_to_date: result.is_up_to_date,
    total_pending_changes: result.total_pending_changes,
    items: result.libraries,
  });
}
