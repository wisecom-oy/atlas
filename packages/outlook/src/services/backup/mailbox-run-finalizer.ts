import type {
  ContactConnector,
  ContactFolder,
  ExcludedFolder,
  FailedItemLedger,
  MailboxDeltaCursorRepository,
  MailboxPurpose,
  Manifest,
  ManifestEntry,
  ManifestObjectLockPolicy,
  ManifestRepository,
  Snapshot,
  SyncOptions,
  TenantContext,
} from '@wisecom/atlas-types';
import { build_manifest } from '@/services/backup/snapshot-manifest-builder';
import {
  persist_mailbox_run,
  type MailboxRunOutcome,
} from '@/services/backup/mailbox-run-persister';
import { sync_contacts_with_history } from '@/services/backup/contact-backup-orchestration';
import type { ContactSyncResult } from '@/services/backup/contact-sync';

export interface MailboxRunFinalization {
  readonly manifest: Manifest;
  readonly persisted: MailboxRunOutcome;
  readonly contact_count?: number;
  readonly contact_stored_objects: number;
  readonly contact_errors: string[];
}

export interface MailboxRunFinalizationInput {
  readonly ctx: TenantContext;
  readonly connector?: ContactConnector | undefined;
  readonly manifests: ManifestRepository;
  readonly cursors: MailboxDeltaCursorRepository;
  readonly tenant_id: string;
  readonly owner_id: string;
  readonly snapshot: Snapshot;
  readonly previous: Manifest | undefined;
  readonly entries: ManifestEntry[];
  readonly saved_links: Record<string, string>;
  readonly new_links: Record<string, string>;
  readonly contact_links: Record<string, string>;
  readonly contact_folders: ContactFolder[];
  readonly failed_contacts: FailedItemLedger;
  readonly previous_entry_count: number;
  readonly mailbox_purpose?: MailboxPurpose | undefined;
  readonly excluded_folders: ExcludedFolder[];
  readonly options: SyncOptions;
  readonly should_interrupt: () => boolean;
}

function manifest_object_lock_policy(options: SyncOptions): ManifestObjectLockPolicy | undefined {
  if (!options.object_lock_policy) return undefined;
  return {
    requested: {
      mode: options.object_lock_request?.mode,
      retention_days: options.object_lock_request?.retention_days,
    },
    effective: {
      mode: options.object_lock_policy.mode,
      retain_until: options.object_lock_policy.retain_until,
    },
  };
}

async function capture_requested_contacts(
  input: MailboxRunFinalizationInput,
): Promise<ContactSyncResult | undefined> {
  if (!input.options.include_contacts || input.should_interrupt()) return undefined;
  if (!input.connector) throw new Error('Contact connector is not configured');
  return sync_contacts_with_history(
    input.ctx,
    input.connector,
    input.manifests,
    input.tenant_id,
    input.owner_id,
    {
      previous_links: input.contact_links,
      previous_folders: input.contact_folders,
      failed: input.failed_contacts,
      force_full: input.options.force_full === true,
      should_interrupt: input.should_interrupt,
      ...(input.options.object_lock_policy
        ? { object_lock_policy: input.options.object_lock_policy }
        : {}),
    },
  );
}

function contact_object_totals(contacts: ContactSyncResult | undefined): {
  count: number;
  bytes: number;
} {
  let count = 0;
  let bytes = 0;
  for (const entry of contacts?.entries ?? []) {
    if (entry.change_type !== 'stored') continue;
    count++;
    bytes += entry.size_bytes + (entry.photo?.size_bytes ?? 0);
  }
  return { count, bytes };
}

/** Captures requested contacts, then writes the manifest before advancing either cursor. */
export async function finalize_mailbox_run(
  input: MailboxRunFinalizationInput,
): Promise<MailboxRunFinalization> {
  const contacts = await capture_requested_contacts(input);
  const totals = contact_object_totals(contacts);
  const base = build_manifest(
    input.owner_id,
    input.snapshot.id,
    input.entries,
    { ...input.saved_links, ...input.new_links },
    {
      previous_total_objects: input.previous_entry_count,
      object_lock: manifest_object_lock_policy(input.options),
      mailbox_purpose: input.mailbox_purpose,
      excluded_folders: input.excluded_folders,
    },
  );
  const manifest = contacts
    ? {
        ...base,
        total_objects: Math.max(base.total_objects, input.entries.length + totals.count),
        total_size_bytes: base.total_size_bytes + totals.bytes,
        contact_entries: contacts.entries,
        contact_folders: contacts.folders,
        contact_delta_links: contacts.delta_links,
      }
    : base;
  const persisted = await persist_mailbox_run(
    { manifests: input.manifests, cursors: input.cursors },
    input.ctx,
    manifest,
    input.snapshot,
    input.previous,
    input.entries.length + totals.count,
    {
      contact_delta_links: contacts?.delta_links ?? input.contact_links,
      contact_folders: contacts?.folders ?? input.contact_folders,
      failed_contacts: contacts?.failed ?? input.failed_contacts,
    },
    contacts?.changed ?? false,
  );
  return {
    manifest,
    persisted,
    contact_stored_objects: contacts?.stored ?? 0,
    contact_errors: contacts?.errors ?? [],
    ...(contacts ? { contact_count: totals.count } : {}),
  };
}
