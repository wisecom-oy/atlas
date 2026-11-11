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

const MAILBOX = '00000000-0000-0000-0000-00000000abcd';
const DAMAGED_KEY = `contacts/manifests/${MAILBOX}/ct-snap-9999-abc.json`;

function harness() {
  const { connector, script, delta_calls } = fake_connector();
  const manifests = memory_manifests();
  const cursors = memory_cursors();
  const service = new ContactsBackupService(
    tenant_factory_for(stub_tenant_context().ctx),
    connector,
    manifests,
    cursors,
  );
  const run = () => service.backup_contacts('tenant-1', MAILBOX);
  return { script, delta_calls, manifests, cursors, run };
}

function full_mailbox(link_suffix: string) {
  return {
    'f-default': {
      upserted: [contact('c1'), contact('c2')],
      removed_ids: [],
      delta_link: `link-default-${link_suffix}`,
      reset: false,
    },
    'f-sub': {
      upserted: [contact('c3')],
      removed_ids: [],
      delta_link: `link-sub-${link_suffix}`,
      reset: false,
    },
  };
}

describe('ContactsBackupService when the newest manifest is unreadable (issue #631)', () => {
  it('reads every folder in full, writes a fresh snapshot and names the damaged key', async () => {
    const h = harness();
    h.script.deltas = full_mailbox('1');
    const first = await h.run();
    // A later snapshot exists but cannot be read; the cursor describes the state it captured.
    h.manifests.find_latest_readable = async () => ({
      manifest: first.snapshot,
      unreadable_keys: [DAMAGED_KEY],
    });
    h.script.deltas = full_mailbox('2');

    const result = await h.run();

    // Resuming from the cursor would build on the older snapshot with links past the damaged one,
    // dropping every change between the two. A full read cannot.
    expect(h.delta_calls.slice(-2).map((call) => call.delta_link)).toEqual([undefined, undefined]);
    // Unchanged against the readable baseline, yet written: the head must become readable again.
    expect(result.snapshot?.entries.map((e) => e.contact_id).sort()).toEqual(['c1', 'c2', 'c3']);
    expect(result.summary.unreadable_keys).toEqual([DAMAGED_KEY]);
    expect(result.summary.healthy).toBe(true);
  });

  it('writes the first readable snapshot when the only manifest is unreadable', async () => {
    const h = harness();
    h.manifests.find_latest_readable = async () => ({
      manifest: undefined,
      unreadable_keys: [DAMAGED_KEY],
    });
    h.script.deltas = full_mailbox('1');

    const result = await h.run();

    expect(result.snapshot).toBeDefined();
    expect(result.summary.unreadable_keys).toEqual([DAMAGED_KEY]);
  });

  it('reports nothing for a run whose newest manifest reads cleanly', async () => {
    const h = harness();
    h.script.deltas = full_mailbox('1');

    const result = await h.run();

    expect(result.summary.unreadable_keys).toBeUndefined();
  });

  it('writes neither snapshot nor cursor when a folder fails on top of the older manifest', async () => {
    const h = harness();
    h.script.deltas = full_mailbox('1');
    const first = await h.run();
    const manifests_before = h.manifests.saved.length;
    h.manifests.find_latest_readable = async () => ({
      manifest: first.snapshot,
      unreadable_keys: [DAMAGED_KEY],
    });
    h.script.deltas = full_mailbox('2');
    h.script.failing_delta_folders.add('f-sub');

    const result = await h.run();

    // The failed folder would keep the older manifest's contacts: a snapshot rolled back past the
    // unreadable one. Nothing is written, and without a cursor the next run reads in full again.
    expect(result.snapshot).toBeUndefined();
    expect(h.manifests.saved).toHaveLength(manifests_before);
    expect(h.cursors.saved).toHaveLength(1);
    expect(result.summary.errors.some((message) => message.includes('Sub'))).toBe(true);
    expect(result.summary.unreadable_keys).toEqual([DAMAGED_KEY]);
  });
});
