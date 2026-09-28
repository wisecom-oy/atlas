import type {
  ContactConnector,
  ContactFolder,
  ExcludedFolder,
  FailedItemLedger,
  MailboxConfigConnector,
  MailboxConfigRef,
  MailFolder,
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
import { AuthError, MailboxNotLicensedError } from '@wisecom/atlas-types';
import { build_manifest } from '@/services/backup/snapshot-manifest-builder';
import {
  persist_mailbox_run,
  type MailboxRunOutcome,
} from '@/services/backup/mailbox-run-persister';
import { sync_contacts_with_history } from '@/services/backup/contact-backup-orchestration';
import type { ContactSyncResult } from '@/services/backup/contact-sync';
import {
  capture_mailbox_config,
  type MailboxConfigCapture,
} from '@/services/backup/mailbox-config-capture';

export interface MailboxRunFinalization {
  readonly manifest: Manifest;
  readonly persisted: MailboxRunOutcome;
  readonly contact_count?: number;
  readonly contact_stored_objects: number;
  /** Contact and configuration failures that leave the run partial. */
  readonly errors: string[];
  readonly config_stored_objects: number;
  readonly config_warnings: string[];
}

export interface MailboxRunFinalizationInput {
  readonly ctx: TenantContext;
  readonly connector?: ContactConnector | undefined;
  readonly config_connector?: MailboxConfigConnector | undefined;
  /** Every folder enumerated this run, to record rule folder paths. */
  readonly folders: MailFolder[];
  readonly mailbox_config: MailboxConfigRef | undefined;
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

interface RequestedContactCapture {
  readonly result?: ContactSyncResult;
  readonly error?: string;
}

async function capture_requested_contacts(
  input: MailboxRunFinalizationInput,
): Promise<RequestedContactCapture> {
  if (!input.options.include_contacts || input.should_interrupt()) return {};
  if (!input.connector) throw new Error('Contact connector is not configured');
  try {
    return {
      result: await sync_contacts_with_history(
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
      ),
    };
  } catch (err) {
    if (err instanceof AuthError || err instanceof MailboxNotLicensedError) throw err;
    return { error: `Contacts: ${err instanceof Error ? err.message : String(err)}` };
  }
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

async function capture_requested_config(
  input: MailboxRunFinalizationInput,
): Promise<MailboxConfigCapture> {
  if (!input.config_connector || input.should_interrupt()) {
    return {
      ref: input.mailbox_config,
      changed: false,
      stored_objects: 0,
      warnings: [],
      errors: [],
    };
  }
  return capture_mailbox_config({
    ctx: input.ctx,
    connector: input.config_connector,
    tenant_id: input.tenant_id,
    owner_id: input.owner_id,
    folders: input.folders,
    previous: input.mailbox_config,
    object_lock_policy: input.options.object_lock_policy,
  });
}

/** Captures contacts and configuration, then writes the manifest before advancing the cursor. */
export async function finalize_mailbox_run(
  input: MailboxRunFinalizationInput,
): Promise<MailboxRunFinalization> {
  const capture = await capture_requested_contacts(input);
  const config = await capture_requested_config(input);
  const contacts = capture.result;
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
  const with_contacts = contacts
    ? {
        ...base,
        total_objects: Math.max(base.total_objects, input.entries.length + totals.count),
        total_size_bytes: base.total_size_bytes + totals.bytes,
        contact_entries: contacts.entries,
        contact_folders: contacts.folders,
        contact_delta_links: contacts.delta_links,
      }
    : base;
  const manifest = config.ref ? { ...with_contacts, mailbox_config: config.ref } : with_contacts;
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
      ...(config.ref ? { mailbox_config: config.ref } : {}),
    },
    (contacts?.changed ?? false) || config.changed,
  );
  return {
    manifest,
    persisted,
    contact_stored_objects: contacts?.stored ?? 0,
    errors: [...(capture.error ? [capture.error] : (contacts?.errors ?? [])), ...config.errors],
    config_stored_objects: config.stored_objects,
    config_warnings: config.warnings,
    ...(contacts ? { contact_count: totals.count } : {}),
  };
}
