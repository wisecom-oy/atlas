import type { Command } from 'commander';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@/utils/config';
import { ATLAS_CONFIG_TOKEN } from '@/utils/config';
import type { MailboxDiscoveryService, TenantMailbox } from '@/ports/mailbox/discovery.port';
import { MAILBOX_DISCOVERY_TOKEN } from '@/ports/tokens/outgoing.tokens';
import { logger } from '@/utils/logger';
import { format_bytes, pad_cell, truncate_cell } from '@/cli/command-formatters';

type ContainerFactory = () => Container;

interface MailboxesOptions {
  tenant?: string;
  licensedOnly?: boolean;
}

/** Registers the `atlas mailboxes` subcommand. */
export function register_mailboxes_command(
  program: Command,
  get_container: ContainerFactory,
): void {
  program
    .command('mailboxes')
    .description('List tenant mailboxes from Microsoft Graph (live, not from backup catalog)')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .option('--licensed-only', 'only show mailboxes with an active Exchange Online license')
    .action((options: MailboxesOptions) => execute_mailboxes(get_container(), options));
}

async function execute_mailboxes(container: Container, options: MailboxesOptions): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  logger.banner('Atlas Mailboxes');
  logger.info(`Tenant: ${tenant_id}`);

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
  logger.info(`${mailboxes.length} mailbox(es) found (${licensed} Exchange-licensed)\n`);

  print_mailbox_table(mailboxes);
}

function resolve_tenant_id(container: Container, options: MailboxesOptions): string {
  if (options.tenant) return options.tenant;
  return container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
}

function print_mailbox_table(mailboxes: TenantMailbox[]): void {
  const has_sizes = mailboxes.some((m) => m.mailbox_size_bytes !== undefined);
  const header =
    '  ' +
    pad_cell('Mail', 38) +
    pad_cell('Display Name', 24) +
    pad_cell('Exchange', 10) +
    pad_cell('Status', 10) +
    (has_sizes ? pad_cell('Size', 12) : '') +
    'Created';
  console.log(header);
  console.log('  ' + '-'.repeat(header.length - 2));

  for (const m of mailboxes) {
    const license_flag = m.has_exchange_license ? 'Yes' : 'No';
    const status = m.exchange_plan_status ?? '--';
    const created = m.created_at ? m.created_at.toISOString().slice(0, 10) : '--';
    const size = has_sizes ? pad_cell(format_size(m.mailbox_size_bytes), 12) : '';
    console.log(
      '  ' +
        pad_cell(truncate_cell(m.mail, 36), 38) +
        pad_cell(truncate_cell(m.display_name, 22), 24) +
        pad_cell(license_flag, 10) +
        pad_cell(status, 10) +
        size +
        created,
    );
  }
}

function format_size(bytes?: number): string {
  if (bytes === undefined) return '--';
  return format_bytes(bytes, 2);
}
