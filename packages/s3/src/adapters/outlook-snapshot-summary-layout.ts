import type {
  MailboxPurpose,
  Manifest,
  ManifestObjectLockEffectivePolicy,
  OutlookSnapshotSummary,
  SnapshotSummary,
} from '@wisecom/atlas-types';
import { is_json_record } from '@wisecom/atlas-core/services/shared/stored-json-reader';
import {
  optional_string,
  stored_count,
  type SnapshotSummaryLayout,
} from '@wisecom/atlas-core/services/shared/snapshot-summary-layout';
import {
  OUTLOOK_MANIFEST_PREFIX,
  outlook_manifest_key,
  read_outlook_manifest,
} from '@/adapters/outlook-manifest-reader';

/** Directory of the per-mailbox manifest pointers, which the summary index sits beside. */
export const OUTLOOK_MANIFEST_POINTER_PREFIX = '_meta/outlook-manifests';

const MAILBOX_PURPOSES: readonly MailboxPurpose[] = [
  'user',
  'linked',
  'shared',
  'room',
  'equipment',
  'others',
];

/** Key of a mailbox's snapshot summary index, beside its `latest.json` pointer. */
export function outlook_summary_key(owner_id: string): string {
  return `${OUTLOOK_MANIFEST_POINTER_PREFIX}/owners/${owner_id}/summary.json`;
}

/** How the Outlook workload keeps its per-mailbox snapshot summary index (#625). */
export const OUTLOOK_SUMMARY_LAYOUT: SnapshotSummaryLayout<Manifest, OutlookSnapshotSummary> = {
  label: 'Outlook',
  summary_key: outlook_summary_key,
  manifest_prefix: (owner_id) => `${OUTLOOK_MANIFEST_PREFIX}/${owner_id}/`,
  manifest_root_prefix: `${OUTLOOK_MANIFEST_PREFIX}/`,
  manifest_key: outlook_manifest_key,
  read_manifest: read_outlook_manifest,
  summarize: summarize_outlook_manifest,
  parse_details: parse_outlook_summary,
};

/** Builds the summary row recorded for an Outlook manifest. */
export function summarize_outlook_manifest(
  manifest: Manifest,
  manifest_key: string,
): OutlookSnapshotSummary {
  const object_lock = manifest.object_lock?.effective;
  return {
    snapshot_id: manifest.snapshot_id,
    created_at: manifest.created_at,
    manifest_key,
    entry_count: manifest.entries.length,
    total_size_bytes: manifest.total_size_bytes,
    owner_id: manifest.owner_id,
    owner_email: manifest.owner_email,
    owner_display_name: manifest.owner_display_name,
    mailbox_purpose: manifest.mailbox_purpose,
    total_objects: manifest.total_objects,
    removed_count: manifest.removed_object_ids?.length ?? 0,
    ...(object_lock?.retain_until ? { object_lock } : {}),
  };
}

/** Reads a stored Outlook row's mailbox fields; undefined when any is malformed. */
function parse_outlook_summary(
  row: Readonly<Record<string, unknown>>,
  common: SnapshotSummary,
): OutlookSnapshotSummary | undefined {
  const owner_id = optional_string(row, 'owner_id');
  const owner_email = optional_string(row, 'owner_email');
  const owner_display_name = optional_string(row, 'owner_display_name');
  const purpose = optional_string(row, 'mailbox_purpose');
  const total_objects = stored_count(row, 'total_objects');
  const removed_count = stored_count(row, 'removed_count');
  const object_lock = parse_object_lock(row.object_lock);
  if (typeof owner_id !== 'string' || owner_email === null || owner_display_name === null) {
    return undefined;
  }
  if (purpose === null || (purpose !== undefined && !is_mailbox_purpose(purpose))) return undefined;
  if (total_objects === undefined || removed_count === undefined || object_lock === null) {
    return undefined;
  }
  return {
    ...common,
    owner_id,
    owner_email,
    owner_display_name,
    mailbox_purpose: purpose,
    total_objects,
    removed_count,
    ...(object_lock ? { object_lock } : {}),
  };
}

function is_mailbox_purpose(value: string): value is MailboxPurpose {
  return (MAILBOX_PURPOSES as readonly string[]).includes(value);
}

/** Reads a stored lock policy; undefined when absent, null when malformed. */
function parse_object_lock(value: unknown): ManifestObjectLockEffectivePolicy | undefined | null {
  if (value === undefined) return undefined;
  if (!is_json_record(value)) return null;
  const { mode, retain_until } = value;
  if (mode !== undefined && mode !== 'GOVERNANCE' && mode !== 'COMPLIANCE') return null;
  if (retain_until !== undefined && typeof retain_until !== 'string') return null;
  return { mode, retain_until };
}
