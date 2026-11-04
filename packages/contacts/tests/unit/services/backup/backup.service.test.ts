import 'reflect-metadata';

import { describe, expect, it, vi } from 'vitest';
import type { ContactsBackupOptions } from '@wisecom/atlas-types';
import {
  contact,
  fake_connector,
  memory_cursors,
  memory_manifests,
  recording_reporter,
  tenant_factory_for,
  type ConnectorScript,
} from '@wisecom/atlas-types/testing/stub-contacts-ports';
import { stub_tenant_context } from '@wisecom/atlas-types/testing/stub-tenant-context';

import { ContactsBackupService } from '@/services/backup/backup.service';

const MAILBOX = '00000000-0000-0000-0000-00000000abcd';

/** Builds a backup service wired to in-memory repositories and a scriptable connector. */
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
  const run = (options: ContactsBackupOptions = {}) =>
    service.backup_contacts('tenant-1', MAILBOX, options);
  return { script, delta_calls, manifests, cursors, run };
}

/** Scripts the default two-folder mailbox with one contact in the root and one in the child. */
function script_initial(script: ConnectorScript): void {
  script.deltas = {
    'f-default': {
      upserted: [contact('c1'), contact('c2')],
      removed_ids: [],
      delta_link: 'link-default-1',
      reset: false,
    },
    'f-sub': {
      upserted: [contact('c3')],
      removed_ids: [],
      delta_link: 'link-sub-1',
      reset: false,
    },
  };
}

function empty_delta(link: string) {
  return { upserted: [], removed_ids: [], delta_link: link, reset: false };
}

function entry_ids(entries: readonly { contact_id: string }[]): string[] {
  return entries.map((entry) => entry.contact_id).sort();
}

describe('ContactsBackupService first run', () => {
  it('writes one snapshot of every folder, saving the manifest before the cursor', async () => {
    const h = harness();
    script_initial(h.script);
    const order: string[] = [];
    const save_manifest = h.manifests.save;
    const save_cursor = h.cursors.save;
    h.manifests.save = async (ctx, manifest) => {
      order.push('manifest');
      await save_manifest(ctx, manifest);
    };
    h.cursors.save = async (ctx, cursor) => {
      order.push('cursor');
      await save_cursor(ctx, cursor);
    };

    const result = await h.run();

    expect(result.snapshot).toBeDefined();
    expect(entry_ids(result.snapshot?.entries ?? [])).toEqual(['c1', 'c2', 'c3']);
    expect(order).toEqual(['manifest', 'cursor']);
    expect(h.cursors.saved.at(-1)?.delta_link_by_folder).toEqual({
      'f-default': 'link-default-1',
      'f-sub': 'link-sub-1',
    });
    expect(result.summary.snapshot_created).toBe(true);
    expect(result.summary.folders_scanned).toBe(2);
    expect(result.summary.healthy).toBe(true);
  });
});

describe('ContactsBackupService incremental run', () => {
  it('applies upserts and removals over the previous snapshot, resuming from stored links', async () => {
    const h = harness();
    script_initial(h.script);
    await h.run();
    h.script.deltas = {
      'f-default': {
        upserted: [contact('c4')],
        removed_ids: ['c2'],
        delta_link: 'link-default-2',
        reset: false,
      },
      'f-sub': empty_delta('link-sub-2'),
    };

    const result = await h.run();

    expect(h.delta_calls.slice(-2)).toEqual([
      { folder_id: 'f-default', delta_link: 'link-default-1' },
      { folder_id: 'f-sub', delta_link: 'link-sub-1' },
    ]);
    expect(entry_ids(result.snapshot?.entries ?? [])).toEqual(['c1', 'c3', 'c4']);
    expect(result.summary.contacts_removed).toBe(1);
  });

  it('keeps unchanged contacts on the same content-addressed objects', async () => {
    const h = harness();
    script_initial(h.script);
    const first = await h.run();
    h.script.deltas = {
      'f-default': {
        upserted: [contact('c4')],
        removed_ids: [],
        delta_link: 'link-default-2',
        reset: false,
      },
      'f-sub': empty_delta('link-sub-2'),
    };

    const second = await h.run();

    const before = first.snapshot?.entries.find((e) => e.contact_id === 'c1');
    const after = second.snapshot?.entries.find((e) => e.contact_id === 'c1');
    expect(after?.storage_key).toBe(before?.storage_key);
    expect(after?.checksum).toBe(before?.checksum);
  });

  it('re-reads every folder without a link when force_full is set', async () => {
    const h = harness();
    script_initial(h.script);
    await h.run();
    h.script.deltas = {
      'f-default': empty_delta('link-default-2'),
      'f-sub': empty_delta('link-sub-2'),
    };

    await h.run({ force_full: true });

    expect(h.delta_calls.slice(-2).map((call) => call.delta_link)).toEqual([undefined, undefined]);
  });
});

describe('ContactsBackupService failure handling', () => {
  it('keeps a folder at its previous entries and link when one of its contacts fails', async () => {
    const h = harness();
    script_initial(h.script);
    await h.run();
    h.script.deltas['f-default'] = {
      upserted: [contact('c5')],
      removed_ids: [],
      delta_link: 'link-default-2',
      reset: false,
    };
    h.script.failing_photo_contacts.add('c5');

    const result = await h.run();

    expect(result.summary.errors).toHaveLength(1);
    expect(result.summary.errors[0]).toContain('Contacts');
    expect(result.summary.healthy).toBe(false);
    expect(result.snapshot).toBeUndefined();
    expect(result.summary.no_snapshot_reason).toBe('no_changes');
    expect(h.cursors.saved.at(-1)?.delta_link_by_folder['f-default']).toBe('link-default-1');
  });

  it('keeps a failing child folder at its previous entries while other folders advance', async () => {
    const h = harness();
    script_initial(h.script);
    await h.run();
    h.script.failing_delta_folders.add('f-sub');
    h.script.deltas['f-default'] = {
      upserted: [contact('c4')],
      removed_ids: [],
      delta_link: 'link-default-2',
      reset: false,
    };

    const result = await h.run();

    expect(result.summary.errors.some((message) => message.includes('Sub'))).toBe(true);
    expect(entry_ids(result.snapshot?.entries ?? [])).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(h.cursors.saved.at(-1)?.delta_link_by_folder).toEqual({
      'f-default': 'link-default-2',
      'f-sub': 'link-sub-1',
    });
  });
});

describe('ContactsBackupService empty runs', () => {
  it('writes no snapshot when nothing changed, but still advances the cursor', async () => {
    const h = harness();
    script_initial(h.script);
    await h.run();
    h.script.deltas = {
      'f-default': empty_delta('link-default-2'),
      'f-sub': empty_delta('link-sub-2'),
    };

    const result = await h.run();

    expect(result.snapshot).toBeUndefined();
    expect(result.summary.no_snapshot_reason).toBe('no_changes');
    expect(h.manifests.saved).toHaveLength(1);
    expect(h.cursors.saved.at(-1)?.delta_link_by_folder['f-default']).toBe('link-default-2');
  });

  it('writes nothing for an empty mailbox and reports no_content', async () => {
    const h = harness();
    h.script.deltas = {
      'f-default': empty_delta('link-default-1'),
      'f-sub': empty_delta('link-sub-1'),
    };

    const result = await h.run();

    expect(result.snapshot).toBeUndefined();
    expect(result.summary.no_snapshot_reason).toBe('no_content');
    expect(h.manifests.saved).toHaveLength(0);
    expect(h.cursors.saved).toHaveLength(1);
  });
});

describe('ContactsBackupService interrupts', () => {
  it('persists nothing when the run is interrupted before the first folder', async () => {
    const h = harness();
    script_initial(h.script);

    const result = await h.run({ should_interrupt: () => true });

    expect(result.interrupted).toBe(true);
    expect(h.manifests.saved).toHaveLength(0);
    expect(h.cursors.saved).toHaveLength(0);
  });

  it('persists nothing when the run is interrupted partway through a folder', async () => {
    const h = harness();
    script_initial(h.script);
    let checks = 0;

    const result = await h.run({
      should_interrupt: () => {
        checks += 1;
        return checks > 2;
      },
    });

    expect(result.interrupted).toBe(true);
    expect(h.manifests.saved).toHaveLength(0);
    expect(h.cursors.saved).toHaveLength(0);
  });
});

describe('ContactsBackupService progress', () => {
  it('asks the presenter for one reporter with the folder rows and finishes it', async () => {
    const h = harness();
    script_initial(h.script);
    const reporter = recording_reporter();
    const create_progress = vi.fn((_rows: { name: string; total_items: number }[]) => reporter);

    await h.run({ create_progress });

    expect(create_progress).toHaveBeenCalledTimes(1);
    expect(create_progress.mock.calls[0]?.[0]).toHaveLength(2);
    expect(reporter.calls).toContain('finish');
  });
});
