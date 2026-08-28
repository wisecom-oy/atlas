import { Box, Text } from 'ink';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN, html_to_text } from '@wisecom/atlas-core';
import type { CatalogUseCase, MailboxSummary } from '@wisecom/atlas-types';
import { CATALOG_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import type { Manifest, AttachmentEntry } from '@wisecom/atlas-types';
import { format_bytes } from '@/command-formatters';
import { logger } from '@wisecom/atlas-core';
import { describe_scope_conflict, resolve_outlook_scope } from '@/commands/outlook-scope';
import { Banner } from '@/ui/components/banner';
import { DataTable, type TableColumn } from '@/ui/components/data-table';
import { KeyValueList, type KeyValueItem } from '@/ui/components/key-value-list';
import { render_static_view } from '@/ui/render';
import { print_mime_message } from '@/commands/outlook-mime-message-view';

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
  const tenant_id = options.tenant ?? container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
  await render_static_view(
    <Box flexDirection="column">
      <Banner title="Atlas List" />
      <KeyValueList items={[{ label: 'Tenant', value: tenant_id }]} />
    </Box>,
  );

  const catalog = container.get<CatalogUseCase>(CATALOG_USE_CASE_TOKEN);

  const scope = resolve_outlook_scope(options);
  const conflict = describe_scope_conflict(scope);
  if (conflict) logger.warn(conflict);

  if (scope.mode === 'snapshot') {
    await print_snapshot_messages(
      catalog,
      tenant_id,
      scope.snapshot,
      options.all,
      options.subjects,
    );
  } else if (scope.mode === 'mailbox') {
    await print_mailbox_snapshots(catalog, tenant_id, scope.mailbox);
  } else {
    await print_all_mailboxes(catalog, tenant_id);
  }
}

/** Fetches, decrypts, and displays a single message. */
export async function execute_outlook_read(
  container: Container,
  options: OutlookReadOptions,
): Promise<void> {
  const tenant_id = options.tenant ?? container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
  const catalog = container.get<CatalogUseCase>(CATALOG_USE_CASE_TOKEN);
  const result = await catalog.read_message(tenant_id, options.snapshot, options.message);

  // Machine-readable output suppresses all decorative output so stdout stays pipeable.
  if (options.raw) {
    if (!result) {
      logger.error(`Message not found. Check the snapshot ID and message ID are correct.`);
      process.exitCode = 1;
      return;
    }
    // Raw MIME goes to stdout verbatim so it can be piped straight into an .eml file.
    if (result.payload_format === 'mime') {
      process.stdout.write(result.raw);
      return;
    }
    console.log(JSON.stringify(result.message, null, 2));
    return;
  }

  await render_static_view(<Banner title="Atlas Read" />);

  if (!result) {
    logger.error(`Message not found. Check the snapshot ID and message ID are correct.`);
    process.exitCode = 1;
    return;
  }

  if (result.payload_format === 'mime') {
    await print_mime_message(result.raw);
    return;
  }

  await print_formatted_message(result.message ?? {});
  await print_attachment_list(result.attachments);
}

/** Prints a table of all backed-up mailboxes with summary stats. */
async function print_all_mailboxes(catalog: CatalogUseCase, tenant_id: string): Promise<void> {
  const mailboxes = await catalog.list_mailboxes(tenant_id);

  if (mailboxes.length === 0) {
    logger.warn('No backed-up mailboxes found');
    return;
  }

  logger.info(`${mailboxes.length} backed-up mailbox(es)\n`);

  interface MailboxRow {
    mailbox: string;
    type: string;
    snapshots: string;
    objects: string;
    size: string;
    last_backup: string;
  }
  const columns: TableColumn<MailboxRow>[] = [
    { key: 'mailbox', header: 'Mailbox' },
    { key: 'type', header: 'Type' },
    { key: 'snapshots', header: 'Snapshots' },
    { key: 'objects', header: 'Objects' },
    { key: 'size', header: 'Size' },
    { key: 'last_backup', header: 'Last backup' },
  ];
  const rows = mailboxes.map((m: MailboxSummary) => ({
    mailbox: m.owner_id,
    type: m.mailbox_purpose ?? '--',
    snapshots: String(m.snapshot_count),
    objects: String(m.total_objects),
    size: format_bytes(m.total_size_bytes),
    last_backup: m.last_backup_at.toISOString().slice(0, 10),
  }));
  await render_static_view(<DataTable columns={columns} rows={rows} />);
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

  interface SnapshotRow {
    snapshot: string;
    objects: string;
    size: string;
    created: string;
  }
  const columns: TableColumn<SnapshotRow>[] = [
    { key: 'snapshot', header: 'Snapshot' },
    { key: 'objects', header: 'Objects' },
    { key: 'size', header: 'Size' },
    { key: 'created', header: 'Created' },
  ];
  const rows = snapshots.map((s: Manifest) => ({
    snapshot: s.snapshot_id,
    objects: String(s.total_objects),
    size: format_bytes(s.total_size_bytes),
    created: new Date(s.created_at).toISOString().slice(0, 19).replace('T', ' '),
  }));
  await render_static_view(<DataTable columns={columns} rows={rows} />);
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

  interface MessageRow {
    num: string;
    size: string;
    att: string;
    subject: string;
  }
  const columns: TableColumn<MessageRow>[] = [
    { key: 'num', header: '#' },
    { key: 'size', header: 'Size' },
    ...(has_att ? [{ key: 'att', header: 'Att' } satisfies TableColumn<MessageRow>] : []),
    { key: 'subject', header: 'Subject', max_width: 60 },
  ];
  const rows = entries.map((e, i) => {
    const att_size = e.attachments?.reduce((sum, a) => sum + a.size_bytes, 0) ?? 0;
    return {
      num: String(i + 1),
      size: format_bytes(e.size_bytes + att_size),
      att: String(e.attachments?.length ?? 0),
      subject: reveal_subjects ? (e.subject ?? '(no subject)') : 'HIDDEN',
    };
  });

  await render_static_view(
    <Box flexDirection="column">
      <DataTable columns={columns} rows={rows} />
      {limit < total ? (
        <Text dimColor>{`\n... (${limit} of ${total} shown, use --all for full list)`}</Text>
      ) : undefined}
      {reveal_subjects ? undefined : (
        <Text dimColor>{'\nSubjects hidden for data protection. Use -S to reveal.'}</Text>
      )}
    </Box>,
  );
}

/** Lists attachment metadata (name, MIME type, size) if any exist. */
async function print_attachment_list(attachments: AttachmentEntry[]): Promise<void> {
  if (attachments.length === 0) return;

  await render_static_view(
    <Box flexDirection="column">
      <Text dimColor>{'-'.repeat(60)}</Text>
      <Text bold>{`Attachments (${attachments.length}):`}</Text>
      {attachments.map((a, i) => (
        <Text key={i}>
          {`  ${i + 1}. ${a.name}  `}
          <Text dimColor>{a.content_type}</Text>
          {`  ${format_bytes(a.size_bytes)}`}
          {a.is_inline ? <Text dimColor>{'  (inline)'}</Text> : undefined}
          {a.storage_key ? undefined : <Text color="yellow">{'  [binary not stored]'}</Text>}
        </Text>
      ))}
    </Box>,
  );
}

/** Prints key message fields in a human-readable format. */
async function print_formatted_message(msg: Record<string, unknown>): Promise<void> {
  const cc = format_recipients(msg['ccRecipients']);
  const items: KeyValueItem[] = [
    { label: 'Subject', value: safe_string(msg['subject']) },
    { label: 'From', value: format_recipient(msg['from']) },
    { label: 'To', value: format_recipients(msg['toRecipients']) },
  ];
  if (cc) items.push({ label: 'Cc', value: cc });
  items.push({ label: 'Date', value: safe_string(msg['receivedDateTime']) });

  await render_static_view(
    <Box flexDirection="column">
      <KeyValueList items={items} />
      <Text dimColor>{'-'.repeat(60)}</Text>
      <Text>{extract_body_preview(msg['body'])}</Text>
    </Box>,
  );
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
