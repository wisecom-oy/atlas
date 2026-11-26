import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import { AuthError } from '@wisecom/atlas-types';
import {
  contact,
  type FakeConnector,
  fake_connector,
  folder,
} from '@wisecom/atlas-types/testing/stub-contacts-ports';
import { graph_error } from '@wisecom/atlas-types/testing/stub-graph-client';
import { stub_tenant_context } from '@wisecom/atlas-types/testing/stub-tenant-context';

import { CONTACTS_READ, graph_call } from '@/adapters/graph-contacts-requests';
import { type FolderSyncDeps, sync_folder } from '@/services/backup/backup-folder-sync';

function deps_with(fake: FakeConnector): FolderSyncDeps {
  return {
    ctx: stub_tenant_context().ctx,
    connector: fake.connector,
    tenant_id: 'tenant-1',
    mailbox_id: 'mailbox-1',
    should_interrupt: () => false,
  };
}

/** A folder of three contacts whose photo request for `c2` gets a 403 with `code`. */
function folder_with_refused_photo(code: string): FakeConnector {
  const fake = fake_connector();
  const upserted = [contact('c1'), contact('c2'), contact('c3')];
  fake.script.deltas['f1'] = { upserted, removed_ids: [], delta_link: 'l2', reset: false };
  fake.connector.fetch_contact_photo = (_tenant, _mailbox, _folder, contact_id) =>
    contact_id === 'c2'
      ? graph_call(CONTACTS_READ, () => Promise.reject(graph_error(403, code, 'Refused')))
      : Promise.resolve(undefined);
  return fake;
}

// Issue #865: only a 403 whose code means a missing grant ends the mailbox run.
describe('a 403 on one contact photo', () => {
  it('fails that contact alone when its code is not a missing grant', async () => {
    const fake = folder_with_refused_photo('UnknownError');

    const result = await sync_folder(deps_with(fake), folder('f1', 'F'), [], 'l1');

    expect(result.complete && result.entries.map((e) => e.contact_id)).toEqual(['c1', 'c3']);
    expect(result.complete && result.errors).toEqual([
      expect.stringContaining('403 UnknownError, which does not name a missing permission'),
    ]);
  });

  it('ends the run when its code means a missing grant', async () => {
    const fake = folder_with_refused_photo('ErrorAccessDenied');

    await expect(sync_folder(deps_with(fake), folder('f1', 'F'), [], 'l1')).rejects.toThrow(
      AuthError,
    );
  });
});
