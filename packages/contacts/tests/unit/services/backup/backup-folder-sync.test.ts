import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import type { BackupProgressReporter, ContactManifestEntry } from '@wisecom/atlas-types';
import { AuthError } from '@wisecom/atlas-types';
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

function entry(contact_id: string, folder_id: string): ContactManifestEntry {
  return { contact_id, folder_id, storage_key: `k-${contact_id}`, checksum: 'x', size_bytes: 1 };
}

describe('sync_folder failure isolation', () => {
  it('drops the rejected link when a reset folder has a failed contact', async () => {
    const fake = fake_connector();
    fake.script.deltas['f1'] = {
      upserted: [contact('c1'), contact('c2')],
      removed_ids: [],
      delta_link: 'link-new',
      reset: true,
    };
    fake.script.failing_photo_contacts.add('c2');

    const result = await sync_folder(deps_with(fake), folder('f1', 'F'), [], 'link-rejected');

    expect(result.complete && result.delta_link).toBeUndefined();
    expect(result.complete && result.entries.map((e) => e.contact_id)).toEqual(['c1']);
  });

  it('stops on an auth failure without attempting the remaining contacts', async () => {
    const fake = fake_connector();
    const upserted = Array.from({ length: 20 }, (_, i) => contact(`c${i}`));
    fake.script.deltas['f1'] = { upserted, removed_ids: [], delta_link: 'l', reset: false };
    let photo_calls = 0;
    fake.connector.fetch_contact_photo = async () => {
      photo_calls += 1;
      throw new AuthError('denied');
    };

    await expect(sync_folder(deps_with(fake), folder('f1', 'F'), [], 'l0')).rejects.toBeInstanceOf(
      AuthError,
    );
    expect(photo_calls).toBeLessThanOrEqual(4);
  });

  it('never runs more than four contacts of a folder at once', async () => {
    const fake = fake_connector();
    const upserted = Array.from({ length: 12 }, (_, i) => contact(`c${i}`));
    fake.script.deltas['f1'] = { upserted, removed_ids: [], delta_link: 'l', reset: false };
    let in_flight = 0;
    let peak = 0;
    fake.connector.fetch_contact_photo = async () => {
      in_flight += 1;
      peak = Math.max(peak, in_flight);
      await Promise.resolve();
      in_flight -= 1;
      return undefined;
    };

    const result = await sync_folder(deps_with(fake), folder('f1', 'F'), [], undefined);

    expect(peak).toBe(4);
    expect(result.complete && result.entries).toHaveLength(12);
  });
});

describe('sync_all_folders', () => {
  it('keeps one entry for a contact moved out of a folder that failed this run', async () => {
    const fake = fake_connector();
    fake.script.failing_delta_folders.add('f-old');
    fake.script.deltas['f-new'] = {
      upserted: [contact('moved')],
      removed_ids: [],
      delta_link: 'l2',
      reset: false,
    };

    const outcome = await sync_all_folders(
      deps_with(fake),
      [folder('f-old', 'Old'), folder('f-new', 'New', ['New'])],
      {
        previous_entries: [entry('moved', 'f-old'), entry('stays', 'f-old')],
        read_links: { 'f-old': 'l-old', 'f-new': 'l-new' },
        kept_links: { 'f-old': 'l-old', 'f-new': 'l-new' },
      },
      {},
      silent_reporter,
    );

    expect(outcome.entries.map((e) => `${e.contact_id}@${e.folder_id}`).sort()).toEqual([
      'moved@f-new',
      'stays@f-old',
    ]);
    expect(outcome.errors).toEqual([expect.stringContaining('Old')]);
  });

  it('ends the run on an auth failure instead of recording one error per folder', async () => {
    const fake = fake_connector();
    fake.connector.fetch_contact_delta = async () => {
      throw new AuthError('denied');
    };

    await expect(
      sync_all_folders(
        deps_with(fake),
        [folder('a', 'A'), folder('b', 'B', ['B'])],
        { previous_entries: [], read_links: {}, kept_links: {} },
        {},
        silent_reporter,
      ),
    ).rejects.toBeInstanceOf(AuthError);
  });
});
