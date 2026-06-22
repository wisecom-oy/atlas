import { createMimeMessage } from 'mimetext';

interface GraphRecipient {
  emailAddress?: { name?: string; address?: string };
}

interface DecryptedAttachment {
  readonly name: string;
  readonly content_type: string;
  readonly content: Buffer;
  readonly is_inline: boolean;
  readonly content_id?: string;
}

/**
 * Converts a decrypted Graph API message JSON and its attachments
 * into an RFC-5322 compliant EML buffer.
 */
export function build_eml(
  message_json: Record<string, unknown>,
  attachments: DecryptedAttachment[],
): Buffer {
  const msg = createMimeMessage();

  const from = extract_email_address(message_json['from'] as GraphRecipient | undefined);
  msg.setSender(from ?? { name: '', addr: 'unknown@localhost' });

  const to = extract_recipient_list(message_json['toRecipients'] as GraphRecipient[] | undefined);
  if (to.length > 0) msg.setTo(to);

  const cc = extract_recipient_list(message_json['ccRecipients'] as GraphRecipient[] | undefined);
  if (cc.length > 0) msg.setCc(cc);

  const bcc = extract_recipient_list(message_json['bccRecipients'] as GraphRecipient[] | undefined);
  if (bcc.length > 0) msg.setBcc(bcc);

  const subject = (message_json['subject'] as string) ?? '(no subject)';
  msg.setSubject(subject);

  set_date_header(msg, message_json);
  set_message_id_header(msg, message_json);

  add_body(msg, message_json);

  for (const att of attachments) {
    const headers: Record<string, string> = {};
    if (att.is_inline && att.content_id) {
      headers['Content-ID'] = att.content_id;
    }
    msg.addAttachment({
      filename: att.name,
      contentType: att.content_type,
      data: att.content.toString('base64'),
      inline: att.is_inline,
      headers,
    });
  }

  return Buffer.from(msg.asRaw(), 'utf-8');
}

/**
 * Generates a filesystem-safe filename from a received timestamp and subject.
 * Format: 2026-03-10_143022_Meeting-with-client.eml
 */
export function build_eml_filename(
  received_date_time: string | undefined,
  subject: string | undefined,
): string {
  const ts = format_timestamp(received_date_time);
  const safe_subject = sanitize_subject(subject ?? 'no-subject');
  return `${ts}_${safe_subject}.eml`;
}

/** Deduplicates a filename within a folder by appending _1, _2, etc. */
export function deduplicate_filename(filename: string, used_names: Set<string>): string {
  if (!used_names.has(filename)) {
    used_names.add(filename);
    return filename;
  }

  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';

  let counter = 1;
  let candidate = `${base}_${counter}${ext}`;
  while (used_names.has(candidate)) {
    counter++;
    candidate = `${base}_${counter}${ext}`;
  }
  used_names.add(candidate);
  return candidate;
}

function extract_email_address(
  recipient: GraphRecipient | undefined,
): { name: string; addr: string } | undefined {
  const addr = recipient?.emailAddress?.address;
  if (!addr) return undefined;
  return { name: recipient?.emailAddress?.name ?? '', addr };
}

function extract_recipient_list(
  recipients: GraphRecipient[] | undefined,
): Array<{ name: string; addr: string }> {
  if (!recipients) return [];
  return recipients
    .map((r) => extract_email_address(r))
    .filter((r): r is { name: string; addr: string } => r !== undefined);
}

function set_date_header(
  msg: ReturnType<typeof createMimeMessage>,
  json: Record<string, unknown>,
): void {
  const received = json['receivedDateTime'] as string | undefined;
  const sent = json['sentDateTime'] as string | undefined;
  const date_str = received ?? sent;
  if (date_str) {
    msg.setHeader('Date', new Date(date_str).toUTCString());
  }
}

function set_message_id_header(
  msg: ReturnType<typeof createMimeMessage>,
  json: Record<string, unknown>,
): void {
  const msg_id = json['internetMessageId'] as string | undefined;
  if (msg_id) {
    msg.setHeader('Message-ID', msg_id);
  }
}

function add_body(msg: ReturnType<typeof createMimeMessage>, json: Record<string, unknown>): void {
  const body = json['body'] as { contentType?: string; content?: string } | undefined;
  const content = body?.content ?? '';
  const content_type = body?.contentType?.toLowerCase() === 'html' ? 'text/html' : 'text/plain';
  msg.addMessage({ contentType: content_type, data: content || ' ' });
}

function format_timestamp(date_str: string | undefined): string {
  if (!date_str) return 'unknown';
  try {
    const d = new Date(date_str);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mi = String(d.getUTCMinutes()).padStart(2, '0');
    const ss = String(d.getUTCSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}_${hh}${mi}${ss}`;
  } catch {
    return 'unknown';
  }
}

const MAX_SUBJECT_LENGTH = 80;

function sanitize_subject(subject: string): string {
  return (
    subject
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      .replace(/\.{2,}/g, '.')
      .replace(/\s+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_SUBJECT_LENGTH) || 'untitled'
  );
}
