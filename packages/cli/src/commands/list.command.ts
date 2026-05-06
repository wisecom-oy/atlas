import type { Command } from 'commander';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@atlas/core';
import { ATLAS_CONFIG_TOKEN } from '@atlas/core';
import type { CatalogUseCase, MailboxSummary } from '@atlas/types';
import { CATALOG_USE_CASE_TOKEN } from '@atlas/types';
import type { Manifest } from '@atlas/types';
import { logger } from '@atlas/core';

type ContainerFactory = () => Container;

interface ListOptions {
  tenant?: string;
  mailbox?: string;
  snapshot?: string;
  all?: boolean;
  subjects?: boolean;
}

const DEFAULT_MESSAGE_LIMIT = 50;

/** Registers the `atlas list` subcommand with three zoom levels. */
export function register_list_command(program: Command, get_container: ContainerFactory): void {
  program
    .command('list')
    .description('Browse backed-up data (mailboxes, snapshots, messages)')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .option('-m, --mailbox <email>', 'list snapshots for a specific mailbox')
    .option('-s, --snapshot <id>', 'list messages inside a specific snapshot')
    .option('--all', 'show all messages (default caps at 50)')
    .option('-S, --subjects', 'reveal email subjects (hidden by default for data protection)')
    .action((options: ListOptions) => execute_list(get_container(), options));
}

/** Routes to the correct zoom level based on provided flags. */
async function execute_list(container: Container, options: ListOptions): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  logger.banner('Atlas List');
  logger.info(`Tenant: ${tenant_id}`);

  const catalog = container.get<CatalogUseCase>(CATALOG_USE_CASE_TOKEN);

  if (options.snapshot) {
    await print_snapshot_messages(
      catalog,
      tenant_id,
      options.snapshot,
      options.all,
      options.subjects,
    );
  } else if (options.mailbox) {
    await print_mailbox_snapshots(catalog, tenant_id, options.mailbox);
  } else {
    await print_all_mailboxes(catalog, tenant_id);
  }
}

/** Resolves the tenant ID from CLI flag or config. */
function resolve_tenant_id(container: Container, options: ListOptions): string {
  if (options.tenant) return options.tenant;
  return container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
}

// ---------------------------------------------------------------------------
// Zoom level 1: all mailboxes
// ---------------------------------------------------------------------------

/** Prints a table of all backed-up mailboxes with summary stats. */
async function print_all_mailboxes(catalog: CatalogUseCase, tenant_id: string): Promise<void> {
  const mailboxes = await catalog.list_mailboxes(tenant_id);

  if (mailboxes.length === 0) {
    logger.warn('No backed-up mailboxes found');
    return;
  }

  logger.info(`${mailboxes.length} backed-up mailbox(es)\n`);
  print_mailbox_table(mailboxes);
}

/** Renders the mailbox summary table. */
function print_mailbox_table(mailboxes: MailboxSummary[]): void {
  const header =
    '  ' +
    pad('Mailbox', 36) +
    pad('Snapshots', 12) +
    pad('Objects', 10) +
    pad('Size', 12) +
    'Last backup';
  console.log(header);
  console.log('  ' + '-'.repeat(header.length - 2));

  for (const m of mailboxes) {
    console.log(
      '  ' +
        pad(m.owner_id, 36) +
        pad(String(m.snapshot_count), 12) +
        pad(String(m.total_objects), 10) +
        pad(format_bytes(m.total_size_bytes), 12) +
        format_date(m.last_backup_at),
    );
  }
}

// ---------------------------------------------------------------------------
// Zoom level 2: snapshots for a mailbox
// ---------------------------------------------------------------------------

/** Prints all snapshots for a given mailbox, sorted newest-first. */
async function print_mailbox_snapshots(
  catalog: CatalogUseCase,
  tenant_id: string,
  mailbox_id: string,
): Promise<void> {
  const snapshots = await catalog.list_snapshots(tenant_id, mailbox_id);

  if (snapshots.length === 0) {
    logger.warn(`No snapshots found for ${mailbox_id}`);
    return;
  }

  logger.info(`${snapshots.length} snapshot(s) for ${mailbox_id}\n`);
  print_snapshot_table(snapshots);
}

/** Renders the snapshot table. */
function print_snapshot_table(snapshots: Manifest[]): void {
  const header = '  ' + pad('Snapshot', 40) + pad('Objects', 10) + pad('Size', 12) + 'Created';
  console.log(header);
  console.log('  ' + '-'.repeat(header.length - 2));

  for (const s of snapshots) {
    console.log(
      '  ' +
        pad(s.snapshot_id, 40) +
        pad(String(s.total_objects), 10) +
        pad(format_bytes(s.total_size_bytes), 12) +
        format_datetime(new Date(s.created_at)),
    );
  }
}

// ---------------------------------------------------------------------------
// Zoom level 3: messages in a snapshot
// ---------------------------------------------------------------------------

/** Prints the messages inside one snapshot, capped at 50 unless --all. */
async function print_snapshot_messages(
  catalog: CatalogUseCase,
  tenant_id: string,
  snapshot_id: string,
  show_all?: boolean,
  reveal_subjects?: boolean,
): Promise<void> {
  const manifest = await catalog.get_snapshot_detail(tenant_id, snapshot_id);

  if (!manifest) {
    logger.error(`Snapshot ${snapshot_id} not found`);
    process.exitCode = 1;
    return;
  }

  const total = manifest.entries.length;
  const limit = show_all ? total : Math.min(total, DEFAULT_MESSAGE_LIMIT);
  const entries = manifest.entries.slice(0, limit);

  logger.info(`Snapshot ${snapshot_id}`);
  logger.info(`Mailbox: ${manifest.owner_id}`);
  logger.info(`${total} message(s), ${format_bytes(manifest.total_size_bytes)}\n`);

  const has_att = entries.some((e) => e.attachments && e.attachments.length > 0);
  const header = '  ' + pad('#', 6) + pad('Size', 10) + (has_att ? pad('Att', 6) : '') + 'Subject';
  console.log(header);
  console.log('  ' + '-'.repeat(76));

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const att_size = e.attachments?.reduce((sum, a) => sum + a.size_bytes, 0) ?? 0;
    const total_entry_size = e.size_bytes + att_size;
    const att_count = e.attachments?.length ?? 0;
    const subject = reveal_subjects ? truncate(e.subject ?? '(no subject)', 60) : 'HIDDEN';

    console.log(
      '  ' +
        pad(String(i + 1), 6) +
        pad(format_bytes(total_entry_size), 10) +
        pad(String(att_count), 6) +
        subject,
    );
  }

  if (limit < total) {
    console.log(`\n  ... (${limit} of ${total} shown, use --all for full list)`);
  }

  if (!reveal_subjects) {
    console.log('\n  Subjects hidden for data protection. Use -S to reveal.');
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function pad(str: string, width: number): string {
  return str.padEnd(width);
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '~' : str;
}

function format_bytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function format_date(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function format_datetime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}
