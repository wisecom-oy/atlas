import 'reflect-metadata';

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import type { ContactManifestEntry, ContactsSnapshotManifest } from '@wisecom/atlas-types';
import {
  memory_manifests,
  tenant_factory_for,
} from '@wisecom/atlas-types/testing/stub-contacts-ports';
import { stub_tenant_context } from '@wisecom/atlas-types/testing/stub-tenant-context';

import { ContactsVerificationService } from '@/services/verification/verification.service';

const MAILBOX = '00000000-0000-0000-0000-00000000abcd';
const SNAPSHOT = 'ct-snap-1-abcdef';

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Stores a contact body (and optional photo) in the object map and returns its manifest entry. */
function stored_entry(
  objects: Record<string, Buffer>,
  id: string,
  photo?: string,
): ContactManifestEntry {
  const body = Buffer.from(`{"id":"${id}"}`);
  const storage_key = `contacts/data/${MAILBOX}/${sha256(body)}`;
  objects[storage_key] = body;
  const entry: ContactManifestEntry = {
    contact_id: id,
    folder_id: 'f-default',
    storage_key,
    checksum: sha256(body),
    size_bytes: body.length,
  };
  if (photo === undefined) return entry;
  const photo_bytes = Buffer.from(photo);
  const photo_storage_key = `contacts/photos/${MAILBOX}/${sha256(photo_bytes)}`;
  objects[photo_storage_key] = photo_bytes;
  return {
    ...entry,
    photo_storage_key,
    photo_checksum: sha256(photo_bytes),
    photo_size_bytes: photo_bytes.length,
  };
}

function snapshot(entries: ContactManifestEntry[]): ContactsSnapshotManifest {
  return {
    id: SNAPSHOT,
    tenant_id: 'tenant-1',
    mailbox_id: MAILBOX,
    snapshot_id: SNAPSHOT,
    created_at: '2025-01-01T00:00:00.000Z',
    total_contacts: entries.length,
    total_size_bytes: entries.reduce((sum, entry) => sum + entry.size_bytes, 0),
    folders: [{ folder_id: 'f-default', display_name: 'Contacts', path: [] }],
    entries,
  };
}

/** Saves a snapshot over the given objects and runs verification of it. */
async function verify(
  objects: Record<string, Buffer>,
  entries: ContactManifestEntry[],
  options: { fast?: boolean; should_interrupt?: () => boolean } = {},
) {
  const { ctx } = stub_tenant_context(objects);
  const manifests = memory_manifests();
  await manifests.save(ctx, snapshot(entries));
  const service = new ContactsVerificationService(tenant_factory_for(ctx), manifests);
  return service.verify_contacts_snapshot('tenant-1', MAILBOX, SNAPSHOT, options);
}

describe('ContactsVerificationService', () => {
  it('passes every stored object in fast mode when all are present', async () => {
    const objects: Record<string, Buffer> = {};
    const entries = [stored_entry(objects, 'c1', 'photo-1'), stored_entry(objects, 'c2')];

    const result = await verify(objects, entries, { fast: true });

    expect(result.total_checked).toBe(3);
    expect(result.passed).toBe(3);
    expect(result.failed).toEqual([]);
    expect(result.interrupted).toBe(false);
  });

  it('counts an absent photo as failed and keeps checking the rest', async () => {
    const objects: Record<string, Buffer> = {};
    const entries = [stored_entry(objects, 'c1', 'photo-1'), stored_entry(objects, 'c2')];
    const photo_key = entries[0]?.photo_storage_key ?? '';
    delete objects[photo_key];

    const result = await verify(objects, entries, { fast: true });

    expect(result.total_checked).toBe(3);
    expect(result.passed).toBe(2);
    expect(result.failed).toEqual([photo_key]);
  });

  it('passes in full mode when stored bytes still match the recorded checksum', async () => {
    const objects: Record<string, Buffer> = {};
    const entries = [stored_entry(objects, 'c1', 'photo-1'), stored_entry(objects, 'c2')];

    const result = await verify(objects, entries, { fast: false });

    expect(result.passed).toBe(3);
    expect(result.failed).toEqual([]);
  });

  it('fails in full mode an object whose bytes no longer match the recorded checksum', async () => {
    const objects: Record<string, Buffer> = {};
    const entries = [stored_entry(objects, 'c1'), stored_entry(objects, 'c2')];
    const tampered_key = entries[0]?.storage_key ?? '';
    objects[tampered_key] = Buffer.from('tampered');

    const result = await verify(objects, entries, { fast: false });

    expect(result.failed).toEqual([tampered_key]);
    expect(result.passed).toBe(1);
  });

  it('checks nothing and reports interrupted when interrupted before the first object', async () => {
    const objects: Record<string, Buffer> = {};
    const entries = [stored_entry(objects, 'c1')];

    const result = await verify(objects, entries, { fast: true, should_interrupt: () => true });

    expect(result.interrupted).toBe(true);
    expect(result.total_checked).toBe(0);
  });

  it('throws NotFoundError when the snapshot manifest does not exist', async () => {
    const { ctx } = stub_tenant_context();
    const service = new ContactsVerificationService(tenant_factory_for(ctx), memory_manifests());

    await expect(
      service.verify_contacts_snapshot('tenant-1', MAILBOX, 'ct-snap-missing'),
    ).rejects.toThrow(/No contacts snapshot ct-snap-missing/);
  });
});
