import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import type { ContactManifestEntry } from '@wisecom/atlas-types';
import { AuthError } from '@wisecom/atlas-types';
import {
  contact,
  memory_manifests,
  tenant_factory_for,
} from '@wisecom/atlas-types/testing/stub-contacts-ports';
import {
  CONTACTS_MAILBOX,
  CONTACTS_SNAPSHOT,
  contacts_snapshot,
  contacts_target,
  type ContactsTarget,
  SOURCE_CONTACT_TAG_ID,
  stored_contact,
} from '@wisecom/atlas-types/testing/stub-contacts-snapshots';
import { stub_tenant_context } from '@wisecom/atlas-types/testing/stub-tenant-context';

import { ContactsRestoreService } from '@/services/restore/restore.service';

/** Saves a snapshot into an in-memory manifest store and runs a restore of it. */
async function restore_with(
  entries: ContactManifestEntry[],
  objects: Record<string, Buffer>,
  target: ContactsTarget,
  options: { should_interrupt?: () => boolean } = {},
) {
  const { ctx } = stub_tenant_context(objects);
  const manifests = memory_manifests();
  await manifests.save(ctx, contacts_snapshot(entries));
  const service = new ContactsRestoreService(tenant_factory_for(ctx), target.connector, manifests);
  return service.restore_contacts('tenant-1', CONTACTS_MAILBOX, {
    snapshot_id: CONTACTS_SNAPSHOT,
    ...options,
  });
}

describe('ContactsRestoreService', () => {
  it('creates the missing child folder under the default folder and restores each contact into its folder', async () => {
    const objects: Record<string, Buffer> = {};
    const entries = [
      stored_contact(objects, 'c1', 'src-default', contact('c1')),
      stored_contact(objects, 'c2', 'src-sub', contact('c2')),
    ];
    const target = contacts_target();

    const result = await restore_with(entries, objects, target);

    expect(target.created_folders).toEqual([{ parent: 'f-default', name: 'Sub' }]);
    expect(result.folders_created).toBe(1);
    expect(target.created.map((c) => c.folder_id)).toEqual(['f-default', 'f-new-1']);
    expect(result.contacts_restored).toBe(2);
    expect(result.errors).toEqual([]);
  });

  it('skips a contact whose name and email already exist in the target folder', async () => {
    const objects: Record<string, Buffer> = {};
    const entries = [
      stored_contact(objects, 'c1', 'src-default', contact('c1')),
      stored_contact(objects, 'c2', 'src-default', contact('c2')),
    ];
    const existing = { ...contact('c1'), id: 'existing-1' };
    const target = contacts_target([existing]);

    const result = await restore_with(entries, objects, target);

    expect(result.contacts_skipped).toBe(1);
    expect(result.contacts_restored).toBe(1);
    expect(target.created.map((c) => c.payload['displayName'])).toEqual(['Contact c2']);
  });

  it('strips Graph read-only fields and @-annotations and tags the contact with its source id', async () => {
    const objects: Record<string, Buffer> = {};
    const payload = {
      ...contact('c1'),
      '@odata.etag': 'W/"example"',
      parentFolderId: 'f-default',
      createdDateTime: '2025-01-01T00:00:00Z',
      changeKey: 'example-key',
    };
    const entries = [stored_contact(objects, 'c1', 'src-default', payload)];
    const target = contacts_target();

    await restore_with(entries, objects, target);

    expect(Object.keys(target.created[0]?.payload ?? {}).sort()).toEqual([
      'displayName',
      'emailAddresses',
      'singleValueExtendedProperties',
    ]);
    expect(target.created[0]?.payload['singleValueExtendedProperties']).toEqual([
      { id: SOURCE_CONTACT_TAG_ID, value: 'c1' },
    ]);
  });

  it('uploads the stored photo to the restored contact', async () => {
    const objects: Record<string, Buffer> = {};
    const photo = Buffer.from([1, 2, 3]);
    const entries = [stored_contact(objects, 'c1', 'src-default', contact('c1'), photo)];
    const target = contacts_target();

    await restore_with(entries, objects, target);

    expect(target.photos).toHaveLength(1);
    expect(target.photos[0]?.contact_id).toBe('new-1');
    expect(Buffer.from(target.photos[0]?.bytes ?? [])).toEqual(photo);
  });

  it('records a checksum mismatch as an error and continues with the next contact', async () => {
    const objects: Record<string, Buffer> = {};
    const first = stored_contact(objects, 'c1', 'src-default', contact('c1'));
    const entries = [
      { ...first, checksum: '0'.repeat(64) },
      stored_contact(objects, 'c2', 'src-default', contact('c2')),
    ];
    const target = contacts_target();

    const result = await restore_with(entries, objects, target);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('c1');
    expect(result.contacts_restored).toBe(1);
  });

  it('counts a contact as restored and reports it when only its photo upload fails', async () => {
    const objects: Record<string, Buffer> = {};
    const entries = [
      stored_contact(objects, 'c1', 'src-default', contact('c1'), Buffer.from([1])),
      stored_contact(objects, 'c2', 'src-default', contact('c2')),
    ];
    const target = contacts_target();
    target.connector.upload_contact_photo = async () => {
      throw new Error('Graph 500');
    };

    const result = await restore_with(entries, objects, target);

    expect(result.contacts_restored).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/c1.*restored without its photo: Graph 500/);
  });

  it('restores the contact without uploading a photo that fails its checksum', async () => {
    const objects: Record<string, Buffer> = {};
    const good = stored_contact(objects, 'c1', 'src-default', contact('c1'), Buffer.from([1]));
    const target = contacts_target();

    const result = await restore_with(
      [{ ...good, photo_checksum: '0'.repeat(64) }],
      objects,
      target,
    );

    expect(result.contacts_restored).toBe(1);
    expect(target.photos).toHaveLength(0);
    expect(result.errors[0]).toMatch(/c1.*restored without its photo/);
  });

  it('stops the restore on an auth failure instead of failing every contact', async () => {
    const objects: Record<string, Buffer> = {};
    const entries = [
      stored_contact(objects, 'c1', 'src-default', contact('c1')),
      stored_contact(objects, 'c2', 'src-default', contact('c2')),
    ];
    const target = contacts_target();
    let attempts = 0;
    target.connector.create_contact = async () => {
      attempts += 1;
      throw new AuthError('denied');
    };

    await expect(restore_with(entries, objects, target)).rejects.toBeInstanceOf(AuthError);
    expect(attempts).toBe(1);
  });

  it('rejects when the snapshot is not in the mailbox', async () => {
    const target = contacts_target();
    const { ctx } = stub_tenant_context();
    const service = new ContactsRestoreService(
      tenant_factory_for(ctx),
      target.connector,
      memory_manifests(),
    );

    await expect(
      service.restore_contacts('tenant-1', CONTACTS_MAILBOX, { snapshot_id: 'ct-snap-missing' }),
    ).rejects.toThrow(/No contacts snapshot ct-snap-missing/);
  });

  it('restores nothing and reports interrupted when interrupted before the first contact', async () => {
    const objects: Record<string, Buffer> = {};
    const entries = [stored_contact(objects, 'c1', 'src-default', contact('c1'))];
    const target = contacts_target();

    const result = await restore_with(entries, objects, target, { should_interrupt: () => true });

    expect(result.interrupted).toBe(true);
    expect(result.contacts_restored).toBe(0);
    expect(target.created).toHaveLength(0);
  });
});
