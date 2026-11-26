import { describe, expect, it, vi } from 'vitest';
import type { OneDriveDeltaCursor } from '@wisecom/atlas-types';
import { UnreadableContentError } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { record_lock_policies } from '@wisecom/atlas-types/testing/lock-policy-recorder';
import { attach_run_retention } from '@wisecom/atlas-core/services/shared/run-object-lock';
import { write_encrypted_json } from '@wisecom/atlas-core/services/shared/stored-json-writer';
import {
  load_drive_cursor,
  save_drive_cursor,
  type CursorSizing,
  type DriveCursorLayout,
} from '@/shared/drive-cursor-store';
import { build_drive_storage_keys } from '@/shared/storage-keys';

const OWNER = 'owner-1';
const LAYOUT: DriveCursorLayout = {
  label: 'OneDrive delta cursor',
  keys: build_drive_storage_keys('onedrive'),
  owner_field: 'owner_id',
};
const SINGLE_KEY = 'onedrive/_meta/owner-1/delta.json';
const HEAD_KEY = 'onedrive/_meta/owner-1/delta/head.json';
const PARTS_PREFIX = 'onedrive/_meta/owner-1/delta/parts/';
/** Splits above 20 items into buckets of about 8, so a test crosses the threshold cheaply. */
const SMALL: CursorSizing = { single_document_items: 20, items_per_part: 8, write_concurrency: 2 };

type Harness = ReturnType<typeof in_memory_tenant_context>;

function cursor(items: number, overrides: Partial<OneDriveDeltaCursor> = {}): OneDriveDeltaCursor {
  const ids = Array.from({ length: items }, (_, i) => `item-${i}`);
  const map = <V>(value: (id: string) => V): Record<string, V> =>
    Object.fromEntries(ids.map((id) => [id, value(id)]));
  return {
    owner_id: OWNER,
    delta_link_by_drive: { 'drive-1': 'https://graph.example/delta?token=1' },
    previous_path_by_file_id: map((id) => `/Documents/${id}`),
    previous_name_by_file_id: map((id) => `${id}.docx`),
    previous_etag_by_file_id: map((id) => `"{${id}},1"`),
    previous_kind_by_file_id: map(() => 'file' as const),
    version_watermark_by_file_id: map(() => ({
      last_modified_at: '2026-01-01T00:00:00Z',
      version_ids: ['1.0'],
    })),
    failed_items: {},
    updated_at: '2026-01-01T00:00:00.000Z',
    snapshot_id: 'od-snap-1-abc',
    ...overrides,
  };
}

const part_keys = (harness: Harness): string[] =>
  harness.keys().filter((key) => key.startsWith(PARTS_PREFIX));

describe('save_drive_cursor and load_drive_cursor (#920)', () => {
  it('stores a small cursor as the single document every release reads', async () => {
    const harness = in_memory_tenant_context();

    await save_drive_cursor(harness.ctx, LAYOUT, cursor(5), SMALL);

    expect(harness.keys()).toEqual([SINGLE_KEY]);
    await expect(load_drive_cursor(harness.ctx, LAYOUT, OWNER)).resolves.toEqual(cursor(5));
  });

  it('stores a large cursor as a head plus parts and reads it back whole', async () => {
    const harness = in_memory_tenant_context();
    const original = cursor(100);

    await save_drive_cursor(harness.ctx, LAYOUT, original, SMALL);

    // No delta.json: an older release finds no cursor and reads the drive in full.
    expect(harness.keys()).not.toContain(SINGLE_KEY);
    expect(harness.keys()).toContain(HEAD_KEY);
    expect(part_keys(harness)).toHaveLength(16);
    await expect(load_drive_cursor(harness.ctx, LAYOUT, OWNER)).resolves.toEqual(original);
  });

  it('keeps an optional map absent, and an empty one present, across the round trip', async () => {
    const harness = in_memory_tenant_context();
    const original = cursor(100, { permission_digest_by_item_id: undefined, failed_items: {} });
    delete (original as { permission_digest_by_item_id?: unknown }).permission_digest_by_item_id;

    await save_drive_cursor(harness.ctx, LAYOUT, original, SMALL);
    const loaded = await load_drive_cursor<OneDriveDeltaCursor>(harness.ctx, LAYOUT, OWNER);

    expect(loaded).not.toHaveProperty('permission_digest_by_item_id');
    expect(loaded?.failed_items).toEqual({});
  });

  it('writes only the head on a run that changed no item', async () => {
    const harness = in_memory_tenant_context();
    await save_drive_cursor(harness.ctx, LAYOUT, cursor(100), SMALL);
    const put = vi.spyOn(harness.ctx.storage, 'put');
    const del = vi.spyOn(harness.ctx.storage, 'delete');
    const next = cursor(100, {
      delta_link_by_drive: { 'drive-1': 'https://graph.example/delta?token=2' },
      updated_at: '2026-01-02T00:00:00.000Z',
    });

    await save_drive_cursor(harness.ctx, LAYOUT, next, SMALL);

    expect(put.mock.calls.map(([key]) => key)).toEqual([HEAD_KEY]);
    expect(del).not.toHaveBeenCalled();
    await expect(load_drive_cursor(harness.ctx, LAYOUT, OWNER)).resolves.toEqual(next);
  });

  it('rewrites only the bucket of a changed item and removes the part it replaced', async () => {
    const harness = in_memory_tenant_context();
    await save_drive_cursor(harness.ctx, LAYOUT, cursor(100), SMALL);
    const before = part_keys(harness);
    const changed = cursor(100);
    changed.previous_etag_by_file_id['item-7'] = '"{item-7},2"';
    const put = vi.spyOn(harness.ctx.storage, 'put');

    await save_drive_cursor(harness.ctx, LAYOUT, changed, SMALL);

    const written = put.mock.calls.map(([key]) => key);
    expect(written.filter((key) => key.startsWith(PARTS_PREFIX))).toHaveLength(1);
    expect(written.at(-1)).toBe(HEAD_KEY);
    const after = part_keys(harness);
    expect(after).toHaveLength(16);
    expect(before.filter((key) => !after.includes(key))).toHaveLength(1);
    await expect(load_drive_cursor(harness.ctx, LAYOUT, OWNER)).resolves.toEqual(changed);
  });

  it('keeps the previous cursor readable when a save is interrupted before its head', async () => {
    const harness = in_memory_tenant_context();
    const previous = cursor(100);
    await save_drive_cursor(harness.ctx, LAYOUT, previous, SMALL);
    const put = harness.ctx.storage.put.bind(harness.ctx.storage);
    const spy = vi.spyOn(harness.ctx.storage, 'put').mockImplementation(async (key, ...rest) => {
      if (key === HEAD_KEY) throw new Error('connection reset');
      return put(key, ...rest);
    });

    await expect(save_drive_cursor(harness.ctx, LAYOUT, cursor(140), SMALL)).rejects.toThrow();
    spy.mockRestore();

    await expect(load_drive_cursor(harness.ctx, LAYOUT, OWNER)).resolves.toEqual(previous);
    const orphans = part_keys(harness).length - 16;
    expect(orphans).toBeGreaterThan(0);
    // A fresh orphan may belong to a run that took the lease over, so it is left for a day.
    await save_drive_cursor(harness.ctx, LAYOUT, previous, SMALL);
    expect(part_keys(harness)).toHaveLength(16 + orphans);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    await save_drive_cursor(harness.ctx, LAYOUT, previous, SMALL);
    vi.useRealTimers();
    expect(part_keys(harness)).toHaveLength(16);
  });

  it('moves between the two forms and leaves only the current one', async () => {
    const harness = in_memory_tenant_context();
    await save_drive_cursor(harness.ctx, LAYOUT, cursor(5), SMALL);

    await save_drive_cursor(harness.ctx, LAYOUT, cursor(100), SMALL);
    expect(harness.keys()).not.toContain(SINGLE_KEY);

    await save_drive_cursor(harness.ctx, LAYOUT, cursor(5), SMALL);
    expect(harness.keys()).toEqual([SINGLE_KEY]);
  });

  it('writes the head and parts without Object Lock, as run state', async () => {
    const harness = in_memory_tenant_context();
    const recorder = record_lock_policies(harness.ctx.storage);
    const ctx = await attach_run_retention(
      { ...harness.ctx, storage: recorder.storage },
      { retention_days: 7 },
    );

    await save_drive_cursor(ctx, LAYOUT, cursor(100), SMALL);

    expect(recorder.locked_keys()).toEqual([]);
    expect(recorder.unlocked_keys()).toContain(HEAD_KEY);
  });
});

describe('load_drive_cursor with older or damaged state', () => {
  it('reads a single-document cursor of any size an older release wrote', async () => {
    const harness = in_memory_tenant_context();
    const legacy = cursor(100);
    await write_encrypted_json(
      harness.ctx,
      {
        key: SINGLE_KEY,
        label: 'cursor',
        reader_check: () => undefined,
        write: 'overwrite',
        confirm_read_back: false,
      },
      legacy,
    );

    await expect(load_drive_cursor(harness.ctx, LAYOUT, OWNER)).resolves.toEqual(legacy);
  });

  it('prefers whichever form was saved later when both exist', async () => {
    const harness = in_memory_tenant_context();
    await save_drive_cursor(harness.ctx, LAYOUT, cursor(100), SMALL);
    const older_release = cursor(3, { updated_at: '2026-02-01T00:00:00.000Z' });
    const raw = Buffer.from(JSON.stringify(older_release));
    harness.set_raw(SINGLE_KEY, harness.ctx.encrypt(raw, SINGLE_KEY));

    await expect(load_drive_cursor(harness.ctx, LAYOUT, OWNER)).resolves.toEqual(older_release);
  });

  it('raises UnreadableContentError for a missing part, after reading the head again', async () => {
    const harness = in_memory_tenant_context();
    await save_drive_cursor(harness.ctx, LAYOUT, cursor(100), SMALL);
    harness.remove(part_keys(harness)[3]!);
    const get = vi.spyOn(harness.ctx.storage, 'get');

    await expect(load_drive_cursor(harness.ctx, LAYOUT, OWNER)).rejects.toBeInstanceOf(
      UnreadableContentError,
    );
    expect(get.mock.calls.filter(([key]) => key === HEAD_KEY)).toHaveLength(2);
  });

  it('refuses a part whose content is not the one its name records', async () => {
    const harness = in_memory_tenant_context();
    await save_drive_cursor(harness.ctx, LAYOUT, cursor(100), SMALL);
    const [first, second] = part_keys(harness);
    const plaintext = harness.ctx.decrypt(harness.raw(second!)!, second!);
    harness.set_raw(first!, harness.ctx.encrypt(plaintext, first!));

    await expect(load_drive_cursor(harness.ctx, LAYOUT, OWNER)).rejects.toThrow(
      'is not the part its name records',
    );
  });

  it("refuses another owner's head stored under this owner's key", async () => {
    const harness = in_memory_tenant_context();
    await save_drive_cursor(harness.ctx, LAYOUT, cursor(100, { owner_id: 'owner-2' }), SMALL);
    const other_head = 'onedrive/_meta/owner-2/delta/head.json';
    const plaintext = harness.ctx.decrypt(harness.raw(other_head)!, other_head);
    harness.set_raw(HEAD_KEY, harness.ctx.encrypt(plaintext, HEAD_KEY));

    await expect(load_drive_cursor(harness.ctx, LAYOUT, OWNER)).rejects.toBeInstanceOf(
      UnreadableContentError,
    );
  });
});
