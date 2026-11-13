import { read_full_snapshot_manifest } from '@wisecom/atlas-core/services/shared/full-snapshot-manifest-store';
import {
  optional_string,
  stored_count,
  type SnapshotSummaryLayout,
} from '@wisecom/atlas-core/services/shared/snapshot-summary-layout';
import type {
  ContactsSnapshotManifest,
  ContactsSnapshotSummary,
  SnapshotSummary,
} from '@wisecom/atlas-types';
import { CONTACTS_MANIFEST_LAYOUT } from '@/adapters/contacts-manifest-layout';
import {
  contacts_manifest_key,
  contacts_manifest_prefix,
  contacts_summary_key,
} from '@/services/shared/storage-keys';

/** How the contacts workload keeps its per-mailbox snapshot summary index (#727). */
export const CONTACTS_SUMMARY_LAYOUT: SnapshotSummaryLayout<
  ContactsSnapshotManifest,
  ContactsSnapshotSummary
> = {
  label: 'Contacts',
  summary_key: contacts_summary_key,
  manifest_prefix: contacts_manifest_prefix,
  manifest_root_prefix: 'contacts/manifests/',
  manifest_key: contacts_manifest_key,
  read_manifest: (ctx, key) =>
    read_full_snapshot_manifest<ContactsSnapshotManifest>(ctx, CONTACTS_MANIFEST_LAYOUT, key),
  summarize: summarize_contacts_manifest,
  parse_details: parse_contacts_summary,
};

/** Builds the summary row recorded for a contacts manifest stored at `manifest_key`. */
export function summarize_contacts_manifest(
  manifest: ContactsSnapshotManifest,
  manifest_key: string,
): ContactsSnapshotSummary {
  return {
    snapshot_id: manifest.snapshot_id,
    created_at: new Date(manifest.created_at),
    manifest_key,
    entry_count: manifest.entries.length,
    total_size_bytes: manifest.total_size_bytes,
    mailbox_id: manifest.mailbox_id,
    total_contacts: manifest.total_contacts,
  };
}

/** Reads a stored contacts row's mailbox and count fields; undefined when any is malformed. */
function parse_contacts_summary(
  row: Readonly<Record<string, unknown>>,
  common: SnapshotSummary,
): ContactsSnapshotSummary | undefined {
  const mailbox_id = optional_string(row, 'mailbox_id');
  const total_contacts = stored_count(row, 'total_contacts');
  if (typeof mailbox_id !== 'string' || total_contacts === undefined) return undefined;
  return { ...common, mailbox_id, total_contacts };
}
