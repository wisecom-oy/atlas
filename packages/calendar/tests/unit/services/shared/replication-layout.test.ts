import { describe, expect, it } from 'vitest';
import type { CalendarSnapshotManifest } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import {
  calendar_replication,
  full_snapshot_mailbox_prefix,
  full_snapshot_manifest_key,
} from '@wisecom/atlas-core/services/replication/full-snapshot-replication-descriptor';
import { list_full_snapshots } from '@wisecom/atlas-core/services/replication/full-snapshot-replication';
import { S3CalendarManifestRepository } from '@/adapters/s3-calendar-manifest-repository.adapter';
import {
  calendar_attachment_key,
  calendar_data_key,
  calendar_manifest_key,
} from '@/services/shared/storage-keys';

/**
 * Issue #715: replication lives in core, which cannot import this package, so it carries its own
 * copy of the calendar layout. These pin that copy to the keys a calendar backup writes.
 */
const MAILBOX = 'User@Example.COM';
const SNAPSHOT = 'cal-snap-1700000000000-abc';

function manifest(): CalendarSnapshotManifest {
  const attachment = (id: string) => ({
    attachment_id: id,
    name: id,
    is_inline: false,
    storage_key: calendar_attachment_key(MAILBOX, id),
    checksum: 'x',
    size_bytes: 1,
  });
  return {
    id: SNAPSHOT,
    tenant_id: 'tenant-1',
    mailbox_id: 'user@example.com',
    snapshot_id: SNAPSHOT,
    created_at: '2025-01-01T00:00:00.000Z',
    total_events: 2,
    total_size_bytes: 3,
    calendars: [{ calendar_id: 'c', display_name: 'Calendar', is_default: true }],
    entries: [
      {
        event_id: 'e1',
        calendar_id: 'c',
        event_type: 'singleInstance',
        storage_key: calendar_data_key(MAILBOX, 'n1'),
        checksum: 'x',
        size_bytes: 1,
        attachments: [attachment('a1'), attachment('a2')],
      },
      {
        event_id: 'e2',
        calendar_id: 'c',
        event_type: 'seriesMaster',
        storage_key: calendar_data_key(MAILBOX, 'n2'),
        checksum: 'x',
        size_bytes: 2,
      },
    ],
  };
}

describe('the calendar layout replication uses', () => {
  const descriptor = calendar_replication(new S3CalendarManifestRepository());

  it('builds the manifest key a calendar backup writes', () => {
    expect(full_snapshot_manifest_key(descriptor, MAILBOX, SNAPSHOT)).toBe(
      calendar_manifest_key(MAILBOX, SNAPSHOT),
    );
  });

  it('names every event and attachment object', () => {
    expect(descriptor.object_keys(manifest())).toEqual([
      calendar_data_key(MAILBOX, 'n1'),
      calendar_attachment_key(MAILBOX, 'a1'),
      calendar_attachment_key(MAILBOX, 'a2'),
      calendar_data_key(MAILBOX, 'n2'),
    ]);
  });

  it('lists a manifest the calendar repository saved, under the mailbox prefix', async () => {
    const bucket = in_memory_tenant_context('tenant-1');
    await new S3CalendarManifestRepository().save(bucket.ctx, manifest());

    const listing = await list_full_snapshots(
      descriptor,
      bucket.ctx,
      full_snapshot_mailbox_prefix(descriptor, MAILBOX),
    );

    expect(listing.unreadable).toEqual([]);
    expect(listing.links.map((link) => link.manifest_key)).toEqual([
      calendar_manifest_key(MAILBOX, SNAPSHOT),
    ]);
    expect(listing.links[0]?.workload).toBe('calendar');
  });
});
