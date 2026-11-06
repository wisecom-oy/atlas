import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';

const UNSAFE_SEGMENT = /[/\\\0]/;

/** Rejects a value that would escape its key prefix or name nothing usable. */
function safe_segment(value: string, label: string): string {
  if (value === '' || value === '.' || value === '..' || UNSAFE_SEGMENT.test(value)) {
    throw new Error(`${label} "${value}" cannot be used as a storage key segment`);
  }
  return value;
}

/** Lowercased mailbox id as a safe key segment. */
export function calendar_mailbox_segment(mailbox_id: string): string {
  return safe_segment(normalize_owner_id(mailbox_id), 'Mailbox id');
}

/** Encrypted event JSON, named by its keyed content name (HMAC, issue #446). */
export function calendar_data_key(mailbox_id: string, content_name: string): string {
  return `calendar/data/${calendar_mailbox_segment(mailbox_id)}/${safe_segment(content_name, 'Content name')}`;
}

/** Encrypted event attachment bytes, named by their keyed content name (HMAC, issue #446). */
export function calendar_attachment_key(mailbox_id: string, content_name: string): string {
  return `calendar/attachments/${calendar_mailbox_segment(mailbox_id)}/${safe_segment(content_name, 'Content name')}`;
}

/** Snapshot manifest object for one snapshot. */
export function calendar_manifest_key(mailbox_id: string, snapshot_id: string): string {
  return `${calendar_manifest_prefix(mailbox_id)}${safe_segment(snapshot_id, 'Snapshot id')}.json`;
}

/** Prefix holding every manifest of a mailbox. */
export function calendar_manifest_prefix(mailbox_id: string): string {
  return `calendar/manifests/${calendar_mailbox_segment(mailbox_id)}/`;
}

/** Encrypted delta cursor for a mailbox. */
export function calendar_delta_cursor_key(mailbox_id: string): string {
  return `calendar/_meta/${calendar_mailbox_segment(mailbox_id)}/delta.json`;
}

/** Every prefix a mailbox's calendar data occupies, for erasure. */
export function calendar_mailbox_prefixes(mailbox_id: string): string[] {
  const segment = calendar_mailbox_segment(mailbox_id);
  return [
    `calendar/data/${segment}/`,
    `calendar/attachments/${segment}/`,
    `calendar/manifests/${segment}/`,
    `calendar/_meta/${segment}/`,
  ];
}
