import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AuthError, MailboxNotLicensedError } from '@wisecom/atlas-types';
import type {
  ContactConnector,
  Manifest,
  StoredContactEntry,
  TenantContext,
} from '@wisecom/atlas-types';
import { resolve_contact_snapshot } from '@wisecom/atlas-core/services/shared/contact-snapshot-chain';
import { CONTACT_FIELDS } from '@/shared/contact-fields';
import {
  order_contact_folders,
  resolve_target_contact_folder,
} from '@/services/restore/contact-folder-tree';

function writable_contact(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid stored contact payload');
  }
  const record = raw as Record<string, unknown>;
  const payload: Record<string, unknown> = {};
  for (const name of CONTACT_FIELDS) {
    if (name in record) payload[name] = record[name];
  }
  return payload;
}

async function read_blob(ctx: TenantContext, key: string, checksum: string): Promise<Buffer> {
  const raw = ctx.decrypt(await ctx.storage.get(key), key);
  if (createHash('sha256').update(raw).digest('hex') !== checksum) {
    throw new Error('Contact backup checksum does not match');
  }
  return raw;
}

function identity(contact: Record<string, unknown>): string | undefined {
  const addresses: unknown = contact.emailAddresses;
  if (Array.isArray(addresses)) {
    const items: unknown[] = addresses;
    for (const item of items) {
      if (
        item &&
        typeof item === 'object' &&
        'address' in item &&
        typeof item.address === 'string'
      ) {
        return item.address.toLowerCase();
      }
    }
  }
  const primary = contact.primaryEmailAddress;
  if (
    primary &&
    typeof primary === 'object' &&
    'address' in primary &&
    typeof primary.address === 'string'
  )
    return primary.address.toLowerCase();
  return undefined;
}

interface ContactRestoreContext {
  readonly ctx: TenantContext;
  readonly connector: ContactConnector;
  readonly tenant_id: string;
  readonly target_id: string;
  readonly target_folder_id: string;
  readonly existing: Record<string, unknown>[];
  readonly existing_by_email: Map<string, Record<string, unknown>[]>;
  readonly claimed_target_ids: Set<string>;
}

function find_existing_contact(
  input: ContactRestoreContext,
  payload: Record<string, unknown>,
  email: string | undefined,
): Record<string, unknown> | undefined {
  if (email) {
    const candidates = input.existing_by_email.get(email) ?? [];
    return (
      candidates.find(
        (candidate) =>
          typeof candidate.id === 'string' &&
          !input.claimed_target_ids.has(candidate.id) &&
          isDeepStrictEqual(writable_contact(candidate), payload),
      ) ??
      candidates.find(
        (candidate) =>
          typeof candidate.id === 'string' && !input.claimed_target_ids.has(candidate.id),
      )
    );
  }
  // ponytail: email-less contacts scan the folder; index fingerprints if they dominate large address books.
  return input.existing.find(
    (candidate) =>
      typeof candidate.id === 'string' &&
      !input.claimed_target_ids.has(candidate.id) &&
      isDeepStrictEqual(writable_contact(candidate), payload),
  );
}

async function restore_contact_entry(
  input: ContactRestoreContext,
  entry: StoredContactEntry,
): Promise<boolean> {
  const raw = await read_blob(input.ctx, entry.storage_key, entry.checksum);
  const payload = writable_contact(JSON.parse(raw.toString('utf8')));
  const email = identity(payload);
  const match = find_existing_contact(input, payload, email);
  let contact_id: string;
  let changed = false;
  if (match) {
    if (typeof match.id !== 'string') throw new Error('Matching Graph contact has no ID');
    contact_id = match.id;
    input.claimed_target_ids.add(contact_id);
    if (!isDeepStrictEqual(writable_contact(match), payload)) {
      await input.connector.update_contact(input.tenant_id, input.target_id, contact_id, payload);
      changed = true;
    }
  } else {
    contact_id = await input.connector.create_contact(
      input.tenant_id,
      input.target_id,
      input.target_folder_id,
      payload,
    );
    const created = { ...payload, id: contact_id };
    input.existing.push(created);
    if (email) {
      const candidates = input.existing_by_email.get(email) ?? [];
      candidates.push(created);
      input.existing_by_email.set(email, candidates);
    }
    input.claimed_target_ids.add(contact_id);
    changed = true;
  }
  if (entry.photo) {
    const photo = await read_blob(input.ctx, entry.photo.storage_key, entry.photo.checksum);
    const current = match
      ? await input.connector.fetch_contact_photo(input.tenant_id, input.target_id, contact_id)
      : undefined;
    if (!current?.equals(photo)) {
      await input.connector.set_contact_photo(input.tenant_id, input.target_id, contact_id, photo);
      changed = true;
    }
  }
  return changed;
}

interface ContactRestoreProgress {
  restored: number;
  errors: string[];
  interrupted: boolean;
}

function index_contacts_by_email(
  contacts: Record<string, unknown>[],
): Map<string, Record<string, unknown>[]> {
  const by_email = new Map<string, Record<string, unknown>[]>();
  for (const candidate of contacts) {
    const address = identity(candidate);
    if (!address) continue;
    const matches = by_email.get(address) ?? [];
    matches.push(candidate);
    by_email.set(address, matches);
  }
  return by_email;
}

async function restore_folder_contacts(
  ctx: TenantContext,
  connector: ContactConnector,
  tenant_id: string,
  target_id: string,
  folder_id: string,
  entries: StoredContactEntry[],
  result: ContactRestoreProgress,
  should_interrupt?: () => boolean,
): Promise<void> {
  if (entries.length === 0) return;
  const existing = await connector.list_contacts(tenant_id, target_id, folder_id);
  const existing_by_email = index_contacts_by_email(existing);
  const input: ContactRestoreContext = {
    ctx,
    connector,
    tenant_id,
    target_id,
    target_folder_id: folder_id,
    existing,
    existing_by_email,
    claimed_target_ids: new Set(),
  };
  for (const entry of entries) {
    if (should_interrupt?.()) {
      result.interrupted = true;
      return;
    }
    try {
      if (await restore_contact_entry(input, entry)) result.restored++;
    } catch (err) {
      if (err instanceof AuthError || err instanceof MailboxNotLicensedError) throw err;
      result.errors.push(
        `Contact ${entry.contact_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Recreates the snapshot's folders and contacts, updating matching contacts only when needed. */
export async function restore_contact_chain(
  ctx: TenantContext,
  connector: ContactConnector,
  tenant_id: string,
  target_id: string,
  manifests: Manifest[],
  should_interrupt?: () => boolean,
): Promise<ContactRestoreProgress> {
  const { folders, entries } = resolve_contact_snapshot(manifests);
  const result: ContactRestoreProgress = { restored: 0, errors: [], interrupted: false };
  if (folders.length === 0) return result;
  const ordered = order_contact_folders(folders);
  const folder_ids = new Map<string, string>();
  const available = await connector.list_contact_folders(tenant_id, target_id);
  const by_folder = new Map<string, StoredContactEntry[]>();
  for (const entry of entries) {
    const current = by_folder.get(entry.folder_id) ?? [];
    current.push(entry);
    by_folder.set(entry.folder_id, current);
  }
  for (const folder of ordered) {
    if (should_interrupt?.()) {
      result.interrupted = true;
      break;
    }
    const source_parent_id = folder.parent_folder_id ?? ordered[0]!.folder_id;
    const target_parent_id = folder.is_default ? undefined : folder_ids.get(source_parent_id);
    if (!folder.is_default && !target_parent_id) {
      throw new Error('Contact folder parent was not restored');
    }
    const folder_id = await resolve_target_contact_folder(
      connector,
      tenant_id,
      target_id,
      folder,
      available,
      target_parent_id,
    );
    folder_ids.set(folder.folder_id, folder_id);
    await restore_folder_contacts(
      ctx,
      connector,
      tenant_id,
      target_id,
      folder_id,
      by_folder.get(folder.folder_id) ?? [],
      result,
      should_interrupt,
    );
    if (result.interrupted) break;
  }
  return result;
}
