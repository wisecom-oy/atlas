import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import {
  contact,
  fake_connector,
  memory_cursors,
  memory_manifests,
  tenant_factory_for,
} from '@wisecom/atlas-types/testing/stub-contacts-ports';
import { stub_tenant_context } from '@wisecom/atlas-types/testing/stub-tenant-context';

import { ContactsBackupService } from '@/services/backup/backup.service';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';

/**
 * Issue #704: after `delete -s` of the newest snapshot the cursor still pointed past the run that
 * wrote it. The next incremental built on the older manifest, trusted the cursor, and never
 * captured the contacts only the deleted snapshot recorded.
 */
const MAILBOX = '00000000-0000-0000-0000-00000000abcd';

function delta(upserted: string[], link: string) {
  return {
    upserted: upserted.map((id) => contact(id)),
    removed_ids: [],
    delta_link: link,
    reset: false,
  };
}

function harness() {
  const { connector, script, delta_calls } = fake_connector();
  const manifests = memory_manifests();
  const cursors = memory_cursors();
  const service = new ContactsBackupService(
    tenant_factory_for(stub_tenant_context().ctx),
    connector,
    manifests,
    cursors,
    stub_owner_leases().leases,
  );
  const run = () => service.backup_contacts('tenant-1', MAILBOX, {});
  return { script, delta_calls, manifests, cursors, run };
}

describe('a contacts backup after the newest snapshot was deleted', () => {
  it('reads every folder in full and captures what the deleted snapshot held', async () => {
    const h = harness();
    h.script.deltas = { 'f-default': delta(['c1'], 'd-1'), 'f-sub': delta([], 's-1') };
    await h.run();
    h.script.deltas = { 'f-default': delta(['c2'], 'd-2'), 'f-sub': delta([], 's-2') };
    await h.run();
    expect(h.manifests.saved).toHaveLength(2);

    // delete -s of the newest snapshot: the manifest goes, a cursor naming it is left behind.
    h.manifests.saved.pop();
    h.delta_calls.length = 0;
    h.script.deltas = { 'f-default': delta(['c1', 'c2'], 'd-3'), 'f-sub': delta([], 's-3') };
    const third = await h.run();

    expect(h.delta_calls.map((c) => c.delta_link)).toEqual([undefined, undefined]);
    expect(third.snapshot?.entries.map((e) => e.contact_id).sort()).toEqual(['c1', 'c2']);
  });

  it('binds the saved cursor to the snapshot the run wrote, or to the head it kept', async () => {
    const h = harness();
    h.script.deltas = { 'f-default': delta(['c1'], 'd-1'), 'f-sub': delta([], 's-1') };
    const first = await h.run();
    expect(h.cursors.saved.at(-1)?.snapshot_id).toBe(first.snapshot?.snapshot_id);

    h.script.deltas = { 'f-default': delta([], 'd-2'), 'f-sub': delta([], 's-2') };
    const quiet = await h.run();

    expect(quiet.snapshot).toBeUndefined();
    expect(h.cursors.saved.at(-1)?.snapshot_id).toBe(first.snapshot?.snapshot_id);
    expect(h.delta_calls.at(-1)?.delta_link).toBe('s-1');
  });
});
