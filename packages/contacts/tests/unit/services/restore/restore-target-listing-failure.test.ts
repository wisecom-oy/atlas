/**
 * Issue #886: a target contact folder whose listing failed after its retries was listed again for
 * every entry, each with a fresh retry budget. The failure is now remembered for the run and
 * reported against each of the folder's entries.
 */
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import {
  AuthError,
  GraphUnavailableError,
  MailboxNotLicensedError,
  type ContactManifestEntry,
} from '@wisecom/atlas-types';
import {
  memory_manifests,
  tenant_factory_for,
} from '@wisecom/atlas-types/testing/stub-contacts-ports';
import {
  CONTACTS_MAILBOX,
  CONTACTS_SNAPSHOT,
  contacts_snapshot,
  contacts_target,
  type ContactsTarget,
  stored_contact,
} from '@wisecom/atlas-types/testing/stub-contacts-snapshots';
import { stub_tenant_context } from '@wisecom/atlas-types/testing/stub-tenant-context';

import { ContactsRestoreService } from '@/services/restore/restore.service';

/** The error a listing gets once every retry of a sustained 503 is spent. */
function exhausted_listing(): GraphUnavailableError {
  return new GraphUnavailableError(
    'Microsoft Graph kept failing after 12 retries: 503 ServiceUnavailable',
    { retries: 12, elapsed_ms: 1_411_000 },
    { status_code: 503 },
  );
}

/** A target whose default folder answers every listing with `failure`, counting the listings. */
function target_failing_default_listing(failure: () => Error): {
  target: ContactsTarget;
  listed: string[];
} {
  const target = contacts_target();
  const listed: string[] = [];
  const list = target.connector.list_folder_contacts.bind(target.connector);
  target.connector.list_folder_contacts = async (tenant, mailbox, folder_id) => {
    listed.push(folder_id);
    if (folder_id === 'f-default') throw failure();
    return list(tenant, mailbox, folder_id);
  };
  return { target, listed };
}

/** Three contacts in the default folder and one in `Sub`. */
function entries_in_two_folders(objects: Record<string, Buffer>): ContactManifestEntry[] {
  return [
    stored_contact(objects, 'c1', 'src-default', { id: 'c1', displayName: 'Person 1' }),
    stored_contact(objects, 'c2', 'src-default', { id: 'c2', displayName: 'Person 2' }),
    stored_contact(objects, 's1', 'src-sub', { id: 's1', displayName: 'Person 3' }),
    stored_contact(objects, 'c3', 'src-default', { id: 'c3', displayName: 'Person 4' }),
  ];
}

/** Restores the four entries into `target`. */
async function restore_into(target: ContactsTarget) {
  const objects: Record<string, Buffer> = {};
  const entries = entries_in_two_folders(objects);
  const { ctx } = stub_tenant_context(objects);
  const manifests = memory_manifests();
  await manifests.save(ctx, contacts_snapshot(entries));
  const service = new ContactsRestoreService(
    tenant_factory_for(ctx),
    target.connector,
    manifests,
    stub_owner_leases().leases,
  );
  return service.restore_contacts('tenant-1', CONTACTS_MAILBOX, {
    snapshot_id: CONTACTS_SNAPSHOT,
  });
}

describe('Contacts restore when a target folder cannot be listed (issue #886)', () => {
  it('lists the failed folder once, not once per entry', async () => {
    const { target, listed } = target_failing_default_listing(exhausted_listing);

    await restore_into(target);

    expect(listed.filter((id) => id === 'f-default')).toHaveLength(1);
  });

  it("reports each of the folder's entries as failed, naming the listing failure", async () => {
    const { target } = target_failing_default_listing(exhausted_listing);

    const result = await restore_into(target);

    expect(result.errors).toEqual(
      ['c1', 'c2', 'c3'].map(
        (contact) =>
          `Contact ${contact} failed to restore: could not list the contacts in the target ` +
          'folder: Microsoft Graph kept failing after 12 retries: 503 ServiceUnavailable',
      ),
    );
  });

  it('still restores the other folders of the run, and never into the failed one', async () => {
    const { target } = target_failing_default_listing(exhausted_listing);

    const result = await restore_into(target);

    expect(result.contacts_restored).toBe(1);
    expect(target.created.map((c) => c.folder_id)).toEqual(['f-new-1']);
  });

  it('still ends the run on an AuthError from the listing', async () => {
    const { target, listed } = target_failing_default_listing(
      () => new AuthError('Contacts.ReadWrite is not granted'),
    );

    await expect(restore_into(target)).rejects.toBeInstanceOf(AuthError);
    expect(listed).toEqual(['f-default']);
  });

  it('still ends the run on a MailboxNotLicensedError from the listing', async () => {
    const { target } = target_failing_default_listing(
      () => new MailboxNotLicensedError('MailboxNotEnabledForRESTAPI'),
    );

    await expect(restore_into(target)).rejects.toBeInstanceOf(MailboxNotLicensedError);
  });
});
