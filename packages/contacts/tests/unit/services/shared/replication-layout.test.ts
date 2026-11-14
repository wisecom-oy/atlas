import { describe, expect, it } from 'vitest';
import type { ContactsSnapshotManifest } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import {
  contacts_replication,
  full_snapshot_mailbox_prefix,
  full_snapshot_manifest_key,
} from '@wisecom/atlas-core/services/replication/full-snapshot-replication-descriptor';
import { list_full_snapshots } from '@wisecom/atlas-core/services/replication/full-snapshot-replication';
import { S3ContactsManifestRepository } from '@/adapters/s3-contacts-manifest-repository.adapter';
import {
  contacts_data_key,
  contacts_manifest_key,
  contacts_photo_key,
} from '@/services/shared/storage-keys';

/**
 * Issue #715: replication lives in core, which cannot import this package, so it carries its own
 * copy of the contacts layout. These pin that copy to the keys a contacts backup writes.
 */
const MAILBOX = 'User@Example.COM';
const SNAPSHOT = 'ct-snap-1700000000000-abc';

function manifest(): ContactsSnapshotManifest {
  return {
    id: SNAPSHOT,
    tenant_id: 'tenant-1',
    mailbox_id: 'user@example.com',
    snapshot_id: SNAPSHOT,
    created_at: '2025-01-01T00:00:00.000Z',
    total_contacts: 2,
    total_size_bytes: 3,
    folders: [{ folder_id: 'f', display_name: 'Contacts', path: [] }],
    entries: [
      {
        contact_id: 'c1',
        folder_id: 'f',
        storage_key: contacts_data_key(MAILBOX, 'n1'),
        checksum: 'x',
        size_bytes: 1,
        photo_storage_key: contacts_photo_key(MAILBOX, 'p1'),
      },
      {
        contact_id: 'c2',
        folder_id: 'f',
        storage_key: contacts_data_key(MAILBOX, 'n2'),
        checksum: 'x',
        size_bytes: 2,
      },
    ],
  };
}

describe('the contacts layout replication uses', () => {
  const descriptor = contacts_replication(new S3ContactsManifestRepository());

  it('builds the manifest key a contacts backup writes', () => {
    expect(full_snapshot_manifest_key(descriptor, MAILBOX, SNAPSHOT)).toBe(
      contacts_manifest_key(MAILBOX, SNAPSHOT),
    );
  });

  it('names every contact and photo object, and no photo for a contact without one', () => {
    expect(descriptor.object_keys(manifest())).toEqual([
      contacts_data_key(MAILBOX, 'n1'),
      contacts_photo_key(MAILBOX, 'p1'),
      contacts_data_key(MAILBOX, 'n2'),
    ]);
  });

  it('lists a manifest the contacts repository saved, under the mailbox prefix', async () => {
    const bucket = in_memory_tenant_context('tenant-1');
    await new S3ContactsManifestRepository().save(bucket.ctx, manifest());

    const listing = await list_full_snapshots(
      descriptor,
      bucket.ctx,
      full_snapshot_mailbox_prefix(descriptor, MAILBOX),
    );

    expect(listing.unreadable).toEqual([]);
    expect(listing.links.map((link) => link.manifest_key)).toEqual([
      contacts_manifest_key(MAILBOX, SNAPSHOT),
    ]);
    expect(listing.links[0]?.workload).toBe('contacts');
  });
});
