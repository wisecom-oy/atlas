import 'reflect-metadata';

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import type { ContactManifestEntry, ContactsSnapshotManifest } from '@wisecom/atlas-types';
import {
  in_memory_tenant_context,
  type InMemoryTenantContext,
} from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import {
  memory_manifests,
  tenant_factory_for,
} from '@wisecom/atlas-types/testing/stub-contacts-ports';

import { ContactsVerificationService } from '@/services/verification/verification.service';

const MAILBOX = '00000000-0000-0000-0000-00000000abcd';
const SNAPSHOT = 'ct-snap-1-abcdef';

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Encrypts a contact body into the bucket with real AES-256-GCM and returns its manifest entry. */
function encrypted_entry(harness: InMemoryTenantContext, id: string): ContactManifestEntry {
  const body = Buffer.from(`{"id":"${id}"}`);
  const storage_key = `contacts/data/${MAILBOX}/${sha256(body)}`;
  harness.set_raw(storage_key, harness.ctx.encrypt(body, storage_key));
  return {
    contact_id: id,
    folder_id: 'f-default',
    storage_key,
    checksum: sha256(body),
    size_bytes: body.length,
  };
}

/** Flips the last ciphertext byte, which the GCM tag check rejects. */
function flip_last_byte(harness: InMemoryTenantContext, key: string): void {
  const bytes = Buffer.from(harness.raw(key) ?? Buffer.alloc(0));
  bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 0xff;
  harness.set_raw(key, bytes);
}

function snapshot(entries: ContactManifestEntry[]): ContactsSnapshotManifest {
  return {
    id: SNAPSHOT,
    tenant_id: 'tenant-1',
    mailbox_id: MAILBOX,
    snapshot_id: SNAPSHOT,
    created_at: '2025-01-01T00:00:00.000Z',
    total_contacts: entries.length,
    total_size_bytes: 0,
    folders: [{ folder_id: 'f-default', display_name: 'Contacts', path: [] }],
    entries,
  };
}

/** Runs full verification of a snapshot over the given entries. */
async function verify_full(harness: InMemoryTenantContext, entries: ContactManifestEntry[]) {
  const manifests = memory_manifests();
  await manifests.save(harness.ctx, snapshot(entries));
  const service = new ContactsVerificationService(tenant_factory_for(harness.ctx), manifests);
  return service.verify_contacts_snapshot('tenant-1', MAILBOX, SNAPSHOT, { fast: false });
}

describe('ContactsVerificationService with tampered ciphertext', () => {
  it('lists every object that fails its GCM tag and keeps checking the rest', async () => {
    const harness = in_memory_tenant_context();
    const entries = ['c1', 'c2', 'c3', 'c4'].map((id) => encrypted_entry(harness, id));
    const tampered = [entries[1]?.storage_key ?? '', entries[3]?.storage_key ?? ''];
    tampered.forEach((key) => flip_last_byte(harness, key));

    const result = await verify_full(harness, entries);

    expect(result.total_checked).toBe(4);
    expect(result.passed).toBe(2);
    expect(result.failed).toEqual(tampered);
  });

  it('fails a truncated object shorter than the GCM header', async () => {
    const harness = in_memory_tenant_context();
    const entries = [encrypted_entry(harness, 'c1'), encrypted_entry(harness, 'c2')];
    const truncated = entries[0]?.storage_key ?? '';
    harness.set_raw(truncated, Buffer.from('short'));

    const result = await verify_full(harness, entries);

    expect(result.failed).toEqual([truncated]);
    expect(result.passed).toBe(1);
  });

  it('propagates a storage error that is not an absent key', async () => {
    const harness = in_memory_tenant_context();
    const entries = [encrypted_entry(harness, 'c1')];
    const outage = Object.assign(new Error('Service Unavailable'), { name: 'ServiceUnavailable' });
    harness.ctx.storage.get = async () => {
      throw outage;
    };

    await expect(verify_full(harness, entries)).rejects.toBe(outage);
  });
});
