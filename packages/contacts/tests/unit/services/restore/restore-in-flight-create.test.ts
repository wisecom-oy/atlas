/**
 * Issue #879: Ctrl+C while a contact create was on the wire aborted it, and the run reported the
 * contact as not restored though Graph may have committed it. The create now finishes and counts,
 * the run then stops as interrupted, and a rerun finds the contact by its source tag.
 */
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import 'reflect-metadata';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';
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

import { CREATE_ONCE } from '@/adapters/graph-contacts-requests';
import { ContactsRestoreService } from '@/services/restore/restore.service';

/** A restore service over two stored contacts, writing into `target`. */
async function restore_service(target: ContactsTarget): Promise<ContactsRestoreService> {
  const objects: Record<string, Buffer> = {};
  const entries = [
    stored_contact(objects, 'c1', 'src-default', { id: 'c1', displayName: 'Person 1' }),
    stored_contact(objects, 'c2', 'src-default', { id: 'c2', displayName: 'Person 2' }),
  ];
  const { ctx } = stub_tenant_context(objects);
  const manifests = memory_manifests();
  await manifests.save(ctx, contacts_snapshot(entries));
  return new ContactsRestoreService(
    tenant_factory_for(ctx),
    target.connector,
    manifests,
    stub_owner_leases().leases,
  );
}

/** Makes every contact create a Graph write that Exchange answers 3 s after it was sent. */
function slow_creates(target: ContactsTarget): () => void {
  const create = target.connector.create_contact.bind(target.connector);
  target.connector.create_contact = (...args) =>
    with_graph_retry(
      () => new Promise<string>((resolve) => setTimeout(() => resolve(create(...args)), 3_000)),
      CREATE_ONCE,
    );
  return () => {
    target.connector.create_contact = create;
  };
}

/** Runs a restore, presses Ctrl+C 1 s in, and settles it. */
async function restore_cancelled_one_second_in(service: ContactsRestoreService) {
  const controller = new AbortController();
  const run = service.restore_contacts('tenant-1', CONTACTS_MAILBOX, {
    snapshot_id: CONTACTS_SNAPSHOT,
    abort_signal: controller.signal,
  });
  await vi.advanceTimersByTimeAsync(1_000);
  controller.abort(new Error('Run interrupted by Ctrl+C'));
  await vi.advanceTimersByTimeAsync(3_000);
  return run;
}

describe('Contacts restore with Ctrl+C during a contact create (issue #879)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts the contact whose create was on the wire, then stops as interrupted', async () => {
    const target = contacts_target();
    slow_creates(target);

    const result = await restore_cancelled_one_second_in(await restore_service(target));

    expect(result.interrupted).toBe(true);
    expect(result.contacts_restored).toBe(1);
    expect(result.errors).toEqual([]);
    expect(target.created.map((c) => c.payload['displayName'])).toEqual(['Person 1']);
  });

  it('creates no duplicate when the interrupted restore is run again', async () => {
    const target = contacts_target();
    const restore_fast_creates = slow_creates(target);
    const service = await restore_service(target);
    await restore_cancelled_one_second_in(service);
    restore_fast_creates();

    const rerun = await service.restore_contacts('tenant-1', CONTACTS_MAILBOX, {
      snapshot_id: CONTACTS_SNAPSHOT,
    });

    expect(rerun.contacts_skipped).toBe(1);
    expect(rerun.contacts_restored).toBe(1);
    expect(target.created.map((c) => c.payload['displayName'])).toEqual(['Person 1', 'Person 2']);
  });
});
