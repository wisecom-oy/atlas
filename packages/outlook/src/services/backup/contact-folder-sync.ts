import { createHash } from 'node:crypto';
import {
  clear_item_failure,
  record_item_failure,
  retryable_items,
} from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import { AuthError, MailboxNotLicensedError } from '@wisecom/atlas-types';
import type {
  ContactChange,
  ContactConnector,
  ContactManifestEntry,
  FailedItemLedger,
  ObjectLockPolicy,
  StoredContactEntry,
  TenantContext,
} from '@wisecom/atlas-types';

export interface ContactFolderSyncOptions {
  should_interrupt?: (() => boolean) | undefined;
  object_lock_policy?: ObjectLockPolicy | undefined;
  load_previous_entries?: (() => Promise<StoredContactEntry[]>) | undefined;
}

export interface ContactFolderSyncInput extends ContactFolderSyncOptions {
  readonly ctx: TenantContext;
  readonly connector: ContactConnector;
  readonly tenant_id: string;
  readonly owner_id: string;
  readonly folder_id: string;
  readonly previous_link?: string | undefined;
  readonly failed: FailedItemLedger;
}

export interface ContactFolderSyncResult {
  readonly entries: ContactManifestEntry[];
  readonly delta_link?: string;
  readonly failed: FailedItemLedger;
  readonly stored: number;
}

interface FolderState {
  readonly pending: Map<string, ContactManifestEntry>;
  readonly seen: Set<string>;
  failed: FailedItemLedger;
  stored: number;
}

interface StoredContactBlob {
  readonly storage_key: string;
  readonly checksum: string;
  readonly size_bytes: number;
  readonly new_object: boolean;
}

async function store_blob(
  ctx: TenantContext,
  prefix: string,
  payload: Buffer,
  policy?: ObjectLockPolicy,
): Promise<StoredContactBlob> {
  const checksum = createHash('sha256').update(payload).digest('hex');
  const storage_key = `${prefix}/${checksum}`;
  const exists = await ctx.storage.exists(storage_key);
  if (!exists) await ctx.storage.put(storage_key, ctx.encrypt(payload, storage_key), {}, policy);
  return { storage_key, checksum, size_bytes: payload.length, new_object: !exists };
}

async function store_contact(
  input: ContactFolderSyncInput,
  change: ContactChange,
): Promise<{ entry: ContactManifestEntry; stored: number }> {
  const { ctx, connector, tenant_id, owner_id, folder_id, object_lock_policy } = input;
  if (change.removed)
    return {
      entry: { contact_id: change.contact_id, folder_id, change_type: 'deleted' },
      stored: 0,
    };
  if (!change.payload) throw new Error('Contact delta item has no payload');
  const payload = Buffer.from(JSON.stringify(change.payload));
  const blob = await store_blob(ctx, `contacts/data/${owner_id}`, payload, object_lock_policy);
  const photo = await connector.fetch_contact_photo(tenant_id, owner_id, change.contact_id);
  const photo_blob =
    photo && (await store_blob(ctx, `contacts/photos/${owner_id}`, photo, object_lock_policy));
  return {
    entry: {
      contact_id: change.contact_id,
      folder_id,
      change_type: 'stored',
      storage_key: blob.storage_key,
      checksum: blob.checksum,
      size_bytes: blob.size_bytes,
      ...(photo_blob
        ? {
            photo: {
              storage_key: photo_blob.storage_key,
              checksum: photo_blob.checksum,
              size_bytes: photo_blob.size_bytes,
            },
          }
        : {}),
    },
    stored: Number(blob.new_object) + Number(photo_blob?.new_object ?? false),
  };
}

async function capture_contact_change(
  input: ContactFolderSyncInput,
  state: FolderState,
  change: ContactChange,
): Promise<void> {
  state.seen.add(change.contact_id);
  try {
    const saved = await store_contact(input, change);
    state.pending.set(change.contact_id, saved.entry);
    state.stored += saved.stored;
    state.failed = clear_item_failure(state.failed, change.contact_id);
  } catch (err) {
    if (err instanceof AuthError || err instanceof MailboxNotLicensedError) throw err;
    state.pending.delete(change.contact_id);
    state.failed = record_item_failure(state.failed, {
      item_id: change.contact_id,
      drive_id: input.folder_id,
      name: 'contact',
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

async function retry_failed_contacts(
  input: ContactFolderSyncInput,
  state: FolderState,
): Promise<void> {
  for (const item of retryable_items(state.failed, input.folder_id)) {
    if (input.should_interrupt?.()) break;
    try {
      const payload = await input.connector.fetch_contact(
        input.tenant_id,
        input.owner_id,
        item.item_id,
      );
      await capture_contact_change(input, state, {
        contact_id: item.item_id,
        removed: false,
        payload,
      });
    } catch (err) {
      if (err && typeof err === 'object' && 'statusCode' in err && err.statusCode === 404) {
        await capture_contact_change(input, state, { contact_id: item.item_id, removed: true });
      } else if (err instanceof AuthError || err instanceof MailboxNotLicensedError) {
        throw err;
      } else if (!state.seen.has(item.item_id)) {
        state.failed = record_item_failure(state.failed, {
          item_id: item.item_id,
          drive_id: input.folder_id,
          name: 'contact',
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

/** Retries failed contacts, streams one folder's delta, and returns only its last change per ID. */
export async function sync_contact_folder(
  input: ContactFolderSyncInput,
): Promise<ContactFolderSyncResult> {
  const state: FolderState = {
    pending: new Map(),
    seen: new Set(),
    failed: input.failed,
    stored: 0,
  };
  await retry_failed_contacts(input, state);
  if (input.should_interrupt?.())
    return {
      entries: [...state.pending.values()],
      failed: state.failed,
      stored: state.stored,
      ...(input.previous_link ? { delta_link: input.previous_link } : {}),
    };
  const result = await input.connector.fetch_contact_delta(
    input.tenant_id,
    input.owner_id,
    input.folder_id,
    input.previous_link,
    async (changes) => {
      for (const change of changes) {
        if (input.should_interrupt?.()) return false;
        await capture_contact_change(input, state, change);
      }
      return !input.should_interrupt?.();
    },
  );
  if (result.delta_link && (!input.previous_link || result.reset) && input.load_previous_entries) {
    for (const prior of await input.load_previous_entries()) {
      if (prior.folder_id !== input.folder_id || state.seen.has(prior.contact_id)) continue;
      state.pending.set(prior.contact_id, {
        contact_id: prior.contact_id,
        folder_id: input.folder_id,
        change_type: 'deleted',
      });
    }
  }
  const delta_link = result.delta_link ?? input.previous_link;
  return {
    entries: [...state.pending.values()],
    failed: state.failed,
    stored: state.stored,
    ...(delta_link ? { delta_link } : {}),
  };
}
