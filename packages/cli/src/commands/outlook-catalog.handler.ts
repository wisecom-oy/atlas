import type { Container } from 'inversify';
import chalk from 'chalk';
import type { AtlasConfig } from '@atlas/core';
import { ATLAS_CONFIG_TOKEN, html_to_text } from '@atlas/core';
import type { CatalogUseCase, MailboxSummary } from '@atlas/types';
import { CATALOG_USE_CASE_TOKEN } from '@atlas/types';
import type { Manifest, AttachmentEntry } from '@atlas/types';
import { format_bytes, pad_cell } from '@/command-formatters';
import { logger } from '@atlas/core';

export interface OutlookListOptions {
  tenant?: string;
  mailbox?: string;
  snapshot?: string;
  all?: boolean;
  subjects?: boolean;
}

export interface OutlookReadOptions {
  tenant?: string;
  snapshot: string;
  message: string;
  raw?: boolean;
}

const DEFAULT_MESSAGE_LIMIT = 50;

/** Routes to the correct zoom level based on provided flags. */
export async function execute_outlook_list(
  container: Container,
  options: OutlookListOptions,
): Promise<void> {
  const tenant_id = resolve_list_tenant_id(container, options);
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

/** Fetches, decrypts, and displays a single message. */
export async function execute_outlook_read(
  container: Container,
  options: OutlookReadOptions,
): Promise<void> {
  const tenant_id = resolve_read_tenant_id(container, options);
  logger.banner('Atlas Read');

  const catalog = container.get<CatalogUseCase>(CATALOG_USE_CASE_TOKEN);
  const result = await catalog.read_message(tenant_id, options.snapshot, options.message);

  if (!result) {
    logger.error(`Message not found. Check the snapshot ID and message ID are correct.`);
    process.exitCode = 1;
    return;
  }

  if (options.raw) {
    console.log(JSON.stringify(result.message, null, 2));
    return;
  }

  print_formatted_message(result.message);
  print_attachment_list(result.attachments);
}

function resolve_list_tenant_id(container: Container, options: OutlookListOptions): string {
  if (options.tenant) return options.tenant;
  return container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
}

function resolve_read_tenant_id(container: Container, options: OutlookReadOptions): string {
  if (options.tenant) return options.tenant;
  return container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
}

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
    pad_cell('Mailbox', 36) +
    pad_cell('Snapshots', 12) +
    pad_cell('Objects', 10) +
    pad_cell('Size', 12) +
    'Last backup';
  console.log(header);
  console.log('  ' + '-'.repeat(header.length - 2));

  for (const m of mailboxes) {
    console.log(
      '  ' +
        pad_cell(m.owner_id, 36) +
        pad_cell(String(m.snapshot_count), 12) +
        pad_cell(String(m.total_objects), 10) +
        pad_cell(format_bytes(m.total_size_bytes), 12) +
        format_date(m.last_backup_at),
    );
  }
}

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
  const header =
    '  ' + pad_cell('Snapshot', 40) + pad_cell('Objects', 10) + pad_cell('Size', 12) + 'Created';
  console.log(header);
  console.log('  ' + '-'.repeat(header.length - 2));

  for (const s of snapshots) {
    console.log(
      '  ' +
        pad_cell(s.snapshot_id, 40) +
        pad_cell(String(s.total_objects), 10) +
        pad_cell(format_bytes(s.total_size_bytes), 12) +
        format_datetime(new Date(s.created_at)),
    );
  }
}

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
  const header =
    '  ' +
    pad_cell('#', 6) +
    pad_cell('Size', 10) +
    (has_att ? pad_cell('Att', 6) : '') +
    'Subject';
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
        pad_cell(String(i + 1), 6) +
        pad_cell(format_bytes(total_entry_size), 10) +
        (has_att ? pad_cell(String(att_count), 6) : '') +
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

/** Lists attachment metadata (name, MIME type, size) if any exist. */
function print_attachment_list(attachments: AttachmentEntry[]): void {
  if (attachments.length === 0) return;

  console.log(chalk.gray('-'.repeat(60)));
  console.log(chalk.bold(`Attachments (${attachments.length}):`));

  for (let i = 0; i < attachments.length; i++) {
    const a = attachments[i]!;
    const inline_tag = a.is_inline ? chalk.gray('  (inline)') : '';
    const skipped = !a.storage_key ? chalk.yellow('  [binary not stored]') : '';
    console.log(
      `  ${i + 1}. ${a.name}  ${chalk.gray(a.content_type)}  ${format_bytes(a.size_bytes)}` +
        inline_tag +
        skipped,
    );
  }
}

/** Prints key message fields in a human-readable format. */
function print_formatted_message(msg: Record<string, unknown>): void {
  const subject = safe_string(msg['subject']);
  const from = format_recipient(msg['from']);
  const to = format_recipients(msg['toRecipients']);
  const cc = format_recipients(msg['ccRecipients']);
  const received = safe_string(msg['receivedDateTime']);
  const body = extract_body_preview(msg['body']);

  console.log(chalk.bold('Subject: ') + subject);
  console.log(chalk.bold('From:    ') + from);
  console.log(chalk.bold('To:      ') + to);
  if (cc) console.log(chalk.bold('Cc:      ') + cc);
  console.log(chalk.bold('Date:    ') + received);
  console.log(chalk.gray('-'.repeat(60)));
  console.log(body);
}

/** Extracts the body content, stripping HTML tags for readability. */
function extract_body_preview(body: unknown): string {
  if (!body || typeof body !== 'object') return '(no body)';

  const obj = body as Record<string, unknown>;
  const content = safe_string(obj['content']);

  if (!content) return '(empty body)';

  if (safe_string(obj['contentType']).toLowerCase() === 'html') {
    return html_to_text(content);
  }

  return content;
}

/** Formats a Graph API { emailAddress: { name, address } } object. */
function format_recipient(recipient: unknown): string {
  if (!recipient || typeof recipient !== 'object') return '(unknown)';

  const obj = recipient as Record<string, unknown>;
  const email_address = obj['emailAddress'] as Record<string, unknown> | undefined;
  if (!email_address) return '(unknown)';

  const name = safe_string(email_address['name']);
  const address = safe_string(email_address['address']);

  return name && name !== address ? `${name} <${address}>` : address || '(unknown)';
}

/** Formats an array of Graph API recipient objects. */
function format_recipients(recipients: unknown): string {
  if (!Array.isArray(recipients) || recipients.length === 0) return '';
  return recipients.map((r) => format_recipient(r)).join(', ');
}

function safe_string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '~' : str;
}

function format_date(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function format_datetime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}
