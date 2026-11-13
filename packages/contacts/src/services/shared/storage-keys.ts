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
export function contacts_mailbox_segment(mailbox_id: string): string {
  return safe_segment(normalize_owner_id(mailbox_id), 'Mailbox id');
}

/** Encrypted contact JSON, named by its keyed content name (HMAC, issue #446). */
export function contacts_data_key(mailbox_id: string, content_name: string): string {
  return `contacts/data/${contacts_mailbox_segment(mailbox_id)}/${safe_segment(content_name, 'Content name')}`;
}

/** Encrypted contact photo bytes, named by their keyed content name (HMAC, issue #446). */
export function contacts_photo_key(mailbox_id: string, content_name: string): string {
  return `contacts/photos/${contacts_mailbox_segment(mailbox_id)}/${safe_segment(content_name, 'Content name')}`;
}

/** Snapshot manifest object for one snapshot. */
export function contacts_manifest_key(mailbox_id: string, snapshot_id: string): string {
  return `${contacts_manifest_prefix(mailbox_id)}${safe_segment(snapshot_id, 'Snapshot id')}.json`;
}

/** Prefix holding every manifest of a mailbox. */
export function contacts_manifest_prefix(mailbox_id: string): string {
  return `contacts/manifests/${contacts_mailbox_segment(mailbox_id)}/`;
}

/** Encrypted delta cursor for a mailbox. */
export function contacts_delta_cursor_key(mailbox_id: string): string {
  return `contacts/_meta/${contacts_mailbox_segment(mailbox_id)}/delta.json`;
}

/** Encrypted snapshot summary index of a mailbox, beside its delta cursor (#727). */
export function contacts_summary_key(mailbox_id: string): string {
  return `contacts/_meta/${contacts_mailbox_segment(mailbox_id)}/snapshots.json`;
}

/** Every prefix a mailbox's contacts data occupies, for erasure. */
export function contacts_mailbox_prefixes(mailbox_id: string): string[] {
  const segment = contacts_mailbox_segment(mailbox_id);
  return [
    `contacts/data/${segment}/`,
    `contacts/photos/${segment}/`,
    `contacts/manifests/${segment}/`,
    `contacts/_meta/${segment}/`,
    // A quarantined manifest still lists this mailbox's items (issue #631).
    `_quarantine/contacts/manifests/${segment}/`,
  ];
}
