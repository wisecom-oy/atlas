import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import type { ObjectStorage } from '@wisecom/atlas-types';
import { tenant_factory_for } from '@wisecom/atlas-types/testing/stub-contacts-ports';
import { stub_tenant_context } from '@wisecom/atlas-types/testing/stub-tenant-context';

import { CalendarDeletionService } from '@/services/deletion/deletion.service';

const MAILBOX = '00000000-0000-0000-0000-00000000abcd';
const OTHER_MAILBOX = '00000000-0000-0000-0000-00000000beef';
const SNAPSHOT = 'cal-snap-1-abcdef';
const MANIFEST_KEY = `calendar/manifests/${MAILBOX}/${SNAPSHOT}.json`;

/** An in-memory bucket with only the listing and delete calls the deletion path uses. */
function deletion_storage(objects: Record<string, Buffer>): ObjectStorage {
  const keys = (prefix: string) =>
    Object.keys(objects)
      .filter((k) => k.startsWith(prefix))
      .sort();
  const storage = {
    list: async (prefix: string) => keys(prefix),
    list_versions: async (prefix: string) =>
      keys(prefix).map((key) => ({ key, version_id: `v-${key}`, is_delete_marker: false })),
    delete: async (key: string) => {
      delete objects[key];
    },
    delete_version: async (key: string) => {
      delete objects[key];
    },
  };
  return storage as unknown as ObjectStorage;
}

/** Objects for one mailbox across every calendar prefix, plus one for another mailbox. */
function seeded_objects(): Record<string, Buffer> {
  const bytes = Buffer.from('x');
  return {
    [`calendar/data/${MAILBOX}/d1`]: bytes,
    [`calendar/attachments/${MAILBOX}/a1`]: bytes,
    [MANIFEST_KEY]: bytes,
    [`calendar/_meta/${MAILBOX}/delta.json`]: bytes,
    [`calendar/data/${OTHER_MAILBOX}/d2`]: bytes,
  };
}

function build_service(objects: Record<string, Buffer>): CalendarDeletionService {
  const { ctx } = stub_tenant_context(objects);
  const storage_only = { tenant_id: 'tenant-1', storage: deletion_storage(objects) };
  return new CalendarDeletionService(tenant_factory_for(ctx, storage_only));
}

describe('CalendarDeletionService', () => {
  it('deletes every calendar prefix of one mailbox and leaves other mailboxes alone', async () => {
    const objects = seeded_objects();

    const result = await build_service(objects).delete_mailbox_data('tenant-1', MAILBOX);

    expect(result.deleted_objects).toBe(3);
    expect(result.deleted_manifests).toBe(1);
    expect(Object.keys(objects)).toEqual([`calendar/data/${OTHER_MAILBOX}/d2`]);
  });

  it('deletes only the named snapshot manifest and keeps the content objects', async () => {
    const objects = seeded_objects();

    const result = await build_service(objects).delete_snapshot('tenant-1', MAILBOX, SNAPSHOT);

    expect(result.deleted_manifests).toBe(1);
    expect(objects[MANIFEST_KEY]).toBeUndefined();
    expect(objects[`calendar/data/${MAILBOX}/d1`]).toBeDefined();
    expect(objects[`calendar/attachments/${MAILBOX}/a1`]).toBeDefined();
  });

  it('throws NotFoundError when the snapshot manifest does not exist', async () => {
    const objects = seeded_objects();

    await expect(
      build_service(objects).delete_snapshot('tenant-1', MAILBOX, 'cal-snap-missing'),
    ).rejects.toThrow(/No Calendar manifest found for snapshot cal-snap-missing/);
  });
});
