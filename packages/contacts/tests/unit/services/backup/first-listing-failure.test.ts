/**
 * Where a "not found" stops a Contacts backup (issue #864).
 *
 * The folder listing decides whether the run happens, so its failure ends the run with nothing
 * written; the connector has already confirmed it, and the error's class carries the exit code. A
 * 404 on one folder's delta after the listing fails only that folder, which the CLI reports as a
 * partial run with exit `2`.
 */

import 'reflect-metadata';

import { describe, expect, it, vi } from 'vitest';
import { GraphUnavailableError } from '@wisecom/atlas-types';
import { graph_error } from '@wisecom/atlas-types/testing/stub-graph-client';
import {
  contact,
  fake_connector,
  folder,
  memory_cursors,
  memory_manifests,
  tenant_factory_for,
} from '@wisecom/atlas-types/testing/stub-contacts-ports';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { stub_tenant_context } from '@wisecom/atlas-types/testing/stub-tenant-context';

import { ContactsBackupService } from '@/services/backup/backup.service';

const MAILBOX = '00000000-0000-0000-0000-00000000abcd';

function delta(link: string, ids: string[]) {
  return {
    upserted: ids.map((id) => contact(id)),
    removed_ids: [],
    delta_link: link,
    reset: false,
  };
}

/** Backup service over in-memory stores, with two folders that each hold one contact. */
function harness() {
  const fake = fake_connector();
  const manifests = memory_manifests();
  const cursors = memory_cursors();
  const service = new ContactsBackupService(
    tenant_factory_for(stub_tenant_context().ctx),
    fake.connector,
    manifests,
    cursors,
    stub_owner_leases().leases,
  );
  fake.script.folders = [folder('f-default', 'Contacts'), folder('f-sub', 'Sub', ['Sub'])];
  fake.script.deltas = {
    'f-default': delta('default-1', ['c-default']),
    'f-sub': delta('sub-1', ['c-sub']),
  };
  return { fake, manifests, cursors, service };
}

describe('Contacts backup and a "not found" answer (issue #864)', () => {
  it('ends the run with the listing failure and writes nothing', async () => {
    const h = harness();
    const unavailable = new GraphUnavailableError('kept answering 404', {
      retries: 2,
      elapsed_ms: 6_000,
    });
    vi.spyOn(h.fake.connector, 'list_contact_folders').mockRejectedValue(unavailable);

    await expect(h.service.backup_contacts('tenant-1', MAILBOX)).rejects.toBe(unavailable);
    expect(h.manifests.saved).toHaveLength(0);
    expect(h.cursors.saved).toHaveLength(0);
  });

  it('fails only the folder whose delta answers 404, and stores the others', async () => {
    const h = harness();
    const read_delta = h.fake.connector.fetch_contact_delta.bind(h.fake.connector);
    vi.spyOn(h.fake.connector, 'fetch_contact_delta').mockImplementation((...args) =>
      args[2] === 'f-sub'
        ? Promise.reject(graph_error(404, 'ErrorItemNotFound'))
        : read_delta(...args),
    );

    const result = await h.service.backup_contacts('tenant-1', MAILBOX);

    expect(result.summary.errors).toHaveLength(1);
    const entries = h.manifests.saved.at(-1)?.entries ?? [];
    expect(entries.map((entry) => entry.contact_id)).toEqual(['c-default']);
  });
});
