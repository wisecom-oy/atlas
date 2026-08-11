import { Box } from 'ink';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import type {
  VerificationUseCase,
  VerificationResult,
  StatusUseCase,
  MailboxStatusResult,
  FolderStatus,
  MailboxDiscoveryService,
  TenantMailbox,
} from '@wisecom/atlas-types';
import {
  VERIFICATION_USE_CASE_TOKEN,
  STATUS_USE_CASE_TOKEN,
  MAILBOX_DISCOVERY_TOKEN,
} from '@wisecom/atlas-types';
import { format_bytes } from '@/command-formatters';
import { logger } from '@wisecom/atlas-core';
import { Banner } from '@/ui/components/banner';
import { DataTable, type TableColumn } from '@/ui/components/data-table';
import { KeyValueList } from '@/ui/components/key-value-list';
import { render_static_view } from '@/ui/render';

export interface OutlookVerifyOptions {
  snapshot: string;
  mailbox: string;
  tenant?: string;
  fast?: boolean;
}

export interface OutlookStatusOptions {
  mailbox: string;
  tenant?: string;
}

export interface OutlookMailboxesOptions {
  tenant?: string;
  licensedOnly?: boolean;
}

/** Runs integrity verification and logs the outcome. */
export async function execute_outlook_verify(
  container: Container,
  options: OutlookVerifyOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  await render_static_view(
    <Box flexDirection="column">
      <Banner title="Atlas Verify" />
      <KeyValueList items={[{ label: 'Mailbox', value: options.mailbox }]} />
    </Box>,
  );
  logger.info(`Verifying snapshot ${options.snapshot}...`);

  const verification_use_case = container.get<VerificationUseCase>(VERIFICATION_USE_CASE_TOKEN);
  const result = await verification_use_case.verify_snapshot_integrity(
    tenant_id,
    options.snapshot,
    {
      fast: options.fast ?? false,
    },
  );
  report_verification_result(result);
}

/** Runs the status check and prints the result. */
export async function execute_outlook_status(
  container: Container,
  options: OutlookStatusOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const status_use_case = container.get<StatusUseCase>(STATUS_USE_CASE_TOKEN);

  await render_static_view(
    <Box flexDirection="column">
      <Banner title="Atlas Status" />
      <KeyValueList
        items={[
          { label: 'Tenant', value: tenant_id },
          { label: 'Mailbox', value: options.mailbox },
        ]}
      />
    </Box>,
  );

  const result = await status_use_case.check_mailbox_status(tenant_id, options.mailbox);
  await print_status_result(result);
}

/** Lists tenant mailboxes from Microsoft Graph. */
export async function execute_outlook_mailboxes(
  container: Container,
  options: OutlookMailboxesOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  await render_static_view(
    <Box flexDirection="column">
      <Banner title="Atlas Mailboxes" />
      <KeyValueList items={[{ label: 'Tenant', value: tenant_id }]} />
    </Box>,
  );

  const discovery = container.get<MailboxDiscoveryService>(MAILBOX_DISCOVERY_TOKEN);
  const discovery_options =
    options.licensedOnly === undefined ? undefined : { licensed_only: options.licensedOnly };
  const mailboxes = await discovery.list_tenant_mailboxes(tenant_id, discovery_options);

  if (mailboxes.length === 0) {
    logger.warn(
      options.licensedOnly
        ? 'No Exchange-licensed mailboxes found in tenant'
        : 'No mailboxes found in tenant',
    );
    return;
  }

  const licensed = mailboxes.filter((m) => m.has_exchange_license).length;
  const shared = mailboxes.filter((m) => m.mailbox_purpose === 'shared').length;
  logger.info(
    `${mailboxes.length} mailbox(es) found (${licensed} Exchange-licensed, ${shared} shared)\n`,
  );

  await print_mailbox_table(mailboxes);
}

function resolve_tenant_id(container: Container, options: { tenant?: string }): string {
  if (options.tenant) return options.tenant;
  const config = container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN);
  return config.tenant_id;
}

function report_verification_result(result: VerificationResult): void {
  logger.info(`Verified merged state across ${result.manifests_in_chain} manifest(s) in the chain`);

  for (const id of result.unverifiable) {
    logger.warn(`  unverifiable (no stored blob): ${id}`);
  }

  if (result.failed.length === 0 && result.unverifiable.length === 0) {
    logger.success(`All ${result.total_checked} objects passed integrity check`);
    return;
  }

  if (result.failed.length > 0) {
    logger.error(`${result.failed.length} of ${result.total_checked} objects failed verification`);
    for (const id of result.failed) {
      logger.error(`  - ${id}`);
    }
  }
  if (result.unverifiable.length > 0) {
    logger.error(
      `${result.unverifiable.length} object(s) have no stored blob and cannot be verified`,
    );
  }
  process.exitCode = 1;
}

interface FolderStatusRow {
  folder: string;
  status: string;
  status_color: string;
  pending: string;
  pending_color: string;
}

/** Derives the status/pending cells and their colors for one folder. */
function build_folder_status_row(f: FolderStatus): FolderStatusRow {
  const total = f.pending_new + f.pending_removed;
  if (!f.has_backup) {
    return {
      folder: f.folder_name,
      status: 'never backed up',
      status_color: 'yellow',
      pending: '-',
      pending_color: 'gray',
    };
  }
  return {
    folder: f.folder_name,
    status: f.is_up_to_date ? 'up-to-date' : `${total} change(s)`,
    status_color: f.is_up_to_date ? 'green' : 'red',
    pending: String(total),
    pending_color: total === 0 ? 'green' : 'red',
  };
}

async function print_status_result(result: MailboxStatusResult): Promise<void> {
  if (result.last_backup_at) {
    const ts = result.last_backup_at.toISOString().replace('T', ' ').slice(0, 16);
    logger.info(`Last backup: ${ts} (${result.last_snapshot_id ?? 'unknown'})\n`);
  } else {
    logger.warn('No previous backup found for this mailbox.\n');
  }

  const columns: TableColumn<FolderStatusRow>[] = [
    { key: 'folder', header: 'Folder', max_width: 26 },
    { key: 'status', header: 'Status', color: (row) => row.status_color },
    { key: 'pending', header: 'Pending', color: (row) => row.pending_color },
  ];
  await render_static_view(
    <DataTable columns={columns} rows={result.folders.map(build_folder_status_row)} />,
  );

  if (result.is_up_to_date) {
    logger.success('Mailbox is up to date -- no pending changes.');
  } else {
    const changes = result.total_pending_changes;
    const not_backed_up = result.folders.filter((f) => !f.has_backup).length;
    const parts: string[] = [];
    if (changes > 0) parts.push(`${changes} pending change(s)`);
    if (not_backed_up > 0) parts.push(`${not_backed_up} folder(s) never backed up`);
    logger.info(`Overall: ${parts.join(', ')} across ${result.total_folders} folder(s)`);
  }
}

async function print_mailbox_table(mailboxes: TenantMailbox[]): Promise<void> {
  const has_sizes = mailboxes.some((m) => m.mailbox_size_bytes !== undefined);

  interface MailboxRow {
    mail: string;
    display_name: string;
    exchange: string;
    status: string;
    type: string;
    size: string;
    created: string;
  }
  const columns: TableColumn<MailboxRow>[] = [
    { key: 'mail', header: 'Mail', max_width: 36 },
    { key: 'display_name', header: 'Display Name', max_width: 22 },
    { key: 'exchange', header: 'Exchange' },
    { key: 'status', header: 'Status' },
    { key: 'type', header: 'Type' },
    ...(has_sizes ? [{ key: 'size', header: 'Size' } satisfies TableColumn<MailboxRow>] : []),
    { key: 'created', header: 'Created' },
  ];
  const rows = mailboxes.map((m) => ({
    mail: m.mail,
    display_name: m.display_name,
    exchange: m.has_exchange_license ? 'Yes' : 'No',
    status: m.exchange_plan_status ?? '--',
    type: m.mailbox_purpose ?? '--',
    size: m.mailbox_size_bytes === undefined ? '--' : format_bytes(m.mailbox_size_bytes, 2),
    created: m.created_at ? m.created_at.toISOString().slice(0, 10) : '--',
  }));
  await render_static_view(<DataTable columns={columns} rows={rows} />);
}
