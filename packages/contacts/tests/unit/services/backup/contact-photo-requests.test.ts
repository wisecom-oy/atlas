import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import type { BackupProgressReporter, ContactManifestEntry } from '@wisecom/atlas-types';
import {
  contact,
  type FakeConnector,
  fake_connector,
  folder,
} from '@wisecom/atlas-types/testing/stub-contacts-ports';
import { stub_tenant_context } from '@wisecom/atlas-types/testing/stub-tenant-context';

import { sync_all_folders } from '@/services/backup/backup-folder-loop';
import { type FolderSyncDeps, sync_folder } from '@/services/backup/backup-folder-sync';

const silent_reporter = new Proxy({}, { get: () => () => undefined }) as BackupProgressReporter;

function deps_with(fake: FakeConnector): FolderSyncDeps {
  return {
    ctx: stub_tenant_context().ctx,
    connector: fake.connector,
    tenant_id: 'tenant-1',
    mailbox_id: 'mailbox-1',
    should_interrupt: () => false,
  };
}

/** Records every photo request and answers with bytes for the contacts in `with_photo`. */
function record_photo_requests(fake: FakeConnector, with_photo: ReadonlySet<string>): string[] {
  const requested: string[] = [];
  fake.connector.fetch_contact_photo = async (_tenant, _mailbox, _folder, contact_id) => {
    requested.push(contact_id);
    return with_photo.has(contact_id) ? new Uint8Array([0xff, 0xd8, 0xff]) : undefined;
  };
  return requested;
}

function entry(contact_id: string, folder_id: string): ContactManifestEntry {
  return { contact_id, folder_id, storage_key: `k-${contact_id}`, checksum: 'x', size_bytes: 1 };
}

describe('contact photo requests (issue #799)', () => {
  it('requests a photo only for contacts that carry an attachment', async () => {
    const fake = fake_connector();
    const upserted = Array.from({ length: 10 }, (_, i) => contact(`c${i}`));
    fake.script.deltas['f1'] = { upserted, removed_ids: [], delta_link: 'l', reset: false };
    fake.script.attachment_ids_by_folder['f1'] = new Set(['c3']);
    const requested = record_photo_requests(fake, new Set(['c3']));

    const result = await sync_folder(deps_with(fake), folder('f1', 'F'), [], undefined);

    expect(requested).toEqual(['c3']);
    const entries = result.complete ? result.entries : [];
    expect(entries).toHaveLength(10);
    expect(
      entries.filter((e) => e.photo_storage_key !== undefined).map((e) => e.contact_id),
    ).toEqual(['c3']);
    expect(entries.find((e) => e.contact_id === 'c3')?.photo_size_bytes).toBe(3);
  });

  it('records no photo for a contact whose attachment is not a photo', async () => {
    const fake = fake_connector();
    fake.script.deltas['f1'] = {
      upserted: [contact('c1')],
      removed_ids: [],
      delta_link: 'l',
      reset: false,
    };
    fake.script.attachment_ids_by_folder['f1'] = new Set(['c1']);
    const requested = record_photo_requests(fake, new Set());

    const result = await sync_folder(deps_with(fake), folder('f1', 'F'), [], undefined);

    expect(requested).toEqual(['c1']);
    expect(result.complete && result.entries[0]?.photo_storage_key).toBeUndefined();
  });

  it('skips the attachment listing when the folder has no changed contacts', async () => {
    const fake = fake_connector();
    fake.script.deltas['f1'] = {
      upserted: [],
      removed_ids: ['gone'],
      delta_link: 'l2',
      reset: false,
    };
    let listings = 0;
    fake.connector.list_contact_ids_with_attachments = async () => {
      listings += 1;
      return new Set();
    };

    const result = await sync_folder(deps_with(fake), folder('f1', 'F'), [], 'l1');

    expect(listings).toBe(0);
    expect(result.complete && result.delta_link).toBe('l2');
  });

  it('keeps the previous folder state and link when the attachment listing fails', async () => {
    const fake = fake_connector();
    fake.script.deltas['f1'] = {
      upserted: [contact('c1')],
      removed_ids: [],
      delta_link: 'l-new',
      reset: false,
    };
    fake.connector.list_contact_ids_with_attachments = async () => {
      throw new Error('listing unavailable');
    };

    const outcome = await sync_all_folders(
      deps_with(fake),
      [folder('f1', 'F')],
      {
        previous_entries: [entry('c0', 'f1')],
        read_links: { f1: 'l-old' },
        kept_links: { f1: 'l-old' },
      },
      {},
      silent_reporter,
    );

    expect(outcome.entries.map((e) => e.contact_id)).toEqual(['c0']);
    expect(outcome.delta_link_by_folder['f1']).toBe('l-old');
    expect(outcome.errors).toEqual([expect.stringContaining('listing unavailable')]);
  });
});
