import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import type { ContactManifestEntry } from '@wisecom/atlas-types';
import { AuthError, MailboxNotLicensedError } from '@wisecom/atlas-types';
import {
  contact,
  type FakeConnector,
  fake_connector,
  folder,
} from '@wisecom/atlas-types/testing/stub-contacts-ports';
import { stub_tenant_context } from '@wisecom/atlas-types/testing/stub-tenant-context';

import { type FolderSyncDeps, sync_folder } from '@/services/backup/backup-folder-sync';

// Issue #854: the photo of a contact whose last request answered "not found" is requested again on
// later runs. That request follows the rules of the first one: only for a contact Exchange lists
// with an attachment, access and licence failures stop the run, and any other failure is a
// contact failure that keeps the entry as it was.

const F1 = folder('f1', 'Contacts');

function deps_with(fake: FakeConnector): FolderSyncDeps {
  return {
    ctx: stub_tenant_context().ctx,
    connector: fake.connector,
    tenant_id: 'tenant-1',
    mailbox_id: 'mailbox-1',
    should_interrupt: () => false,
  };
}

/** An entry whose photo answered "not found" once, an hour ago, so it is still owed a request. */
function pending_entry(contact_id: string): ContactManifestEntry {
  return {
    contact_id,
    folder_id: 'f1',
    storage_key: `k-${contact_id}`,
    checksum: `sum-${contact_id}`,
    size_bytes: 1,
    photo_not_found: { reads: 1, since: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
  };
}

function script_empty_delta(fake: FakeConnector): void {
  fake.script.deltas['f1'] = { upserted: [], removed_ids: [], delta_link: 'l2', reset: false };
}

describe('the repeated photo request after a "not found" (issue #854)', () => {
  it('sends no photo request for a contact delta lists without an attachment', async () => {
    const fake = fake_connector();
    fake.script.deltas['f1'] = {
      upserted: [contact('c1'), contact('c2')],
      removed_ids: [],
      delta_link: 'l2',
      reset: false,
    };
    fake.script.attachment_ids_by_folder['f1'] = new Set();
    const requested: string[] = [];
    fake.connector.fetch_contact_photo = async (_t, _m, _f, contact_id) => {
      requested.push(contact_id);
      return undefined;
    };

    const result = await sync_folder(deps_with(fake), F1, [pending_entry('c1')], 'l1');

    expect(requested).toEqual([]);
    const entries = result.complete ? result.entries : [];
    expect(entries.map((e) => e.photo_not_found)).toEqual([undefined, undefined]);
  });

  it('sends no request for a contact the delta removed', async () => {
    const fake = fake_connector();
    fake.script.deltas['f1'] = {
      upserted: [],
      removed_ids: ['c1'],
      delta_link: 'l2',
      reset: false,
    };
    let requests = 0;
    fake.connector.fetch_contact_photo = async () => {
      requests += 1;
      return undefined;
    };

    const result = await sync_folder(deps_with(fake), F1, [pending_entry('c1')], 'l1');

    expect(requests).toBe(0);
    expect(result.complete && result.entries).toEqual([]);
  });

  it.each([
    ['an access failure', new AuthError('denied')],
    ['a licence failure', new MailboxNotLicensedError('mailbox-1')],
  ])('stops the run on %s', async (_label, failure) => {
    const fake = fake_connector();
    script_empty_delta(fake);
    fake.connector.fetch_contact_photo = async () => {
      throw failure;
    };

    await expect(sync_folder(deps_with(fake), F1, [pending_entry('c1')], 'l1')).rejects.toBe(
      failure,
    );
  });

  it('records any other failure and keeps the entry and the old link', async () => {
    const fake = fake_connector();
    script_empty_delta(fake);
    fake.script.failing_photo_contacts.add('c1');
    const pending = pending_entry('c1');

    const result = await sync_folder(deps_with(fake), F1, [pending], 'l1');

    expect(result.complete && result.entries).toEqual([pending]);
    expect(result.complete && result.errors).toEqual([
      expect.stringContaining('photo unavailable'),
    ]);
    expect(result.complete && result.delta_link).toBe('l1');
  });
});
