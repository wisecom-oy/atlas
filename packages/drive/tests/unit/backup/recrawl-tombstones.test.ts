import { describe, it, expect } from 'vitest';
import { append_recrawl_tombstones } from '@/backup/recrawl-tombstones';
import { readable_manifests } from '@wisecom/atlas-types/testing/readable-listing';

/**
 * Issue #626. `push(...tombstones)` passes every tombstone as a call argument and throws
 * `RangeError` past V8's argument limit (about 125k on Node 22), so a re-crawl that found a large
 * deleted tree failed the whole run.
 */
const BEYOND_ARGUMENT_LIMIT = 300_000;

interface Entry {
  readonly file_id: string;
  readonly drive_id: string;
  readonly storage_key?: string;
  readonly checksum?: string;
  readonly change_type: string;
  readonly backup_at: string;
}

function stored_entry(i: number): Entry {
  return {
    file_id: `f-${i}`,
    drive_id: 'd1',
    storage_key: `content/${i}`,
    checksum: `sum-${i}`,
    change_type: 'created',
    backup_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('append_recrawl_tombstones', () => {
  it('tombstones more files than the engine argument limit', async () => {
    const previous = Array.from({ length: BEYOND_ARGUMENT_LIMIT }, (_, i) => stored_entry(i));
    const scan = {
      entries: [] as Entry[],
      deleted_items: 0,
      recrawls: [{ drive_id: 'd1', returned_item_ids: new Set<string>() }],
    };

    await append_recrawl_tombstones(scan, async () =>
      readable_manifests([
        { snapshot_id: 'snap-1', created_at: new Date('2026-01-01'), entries: previous },
      ]),
    );

    expect(scan.entries).toHaveLength(BEYOND_ARGUMENT_LIMIT);
    expect(scan.deleted_items).toBe(BEYOND_ARGUMENT_LIMIT);
    expect(scan.entries[0]).toMatchObject({ file_id: 'f-0', change_type: 'deleted' });
    expect(scan.entries[0]).not.toHaveProperty('storage_key');
  });
});

describe('append_recrawl_tombstones with a damaged earlier manifest (issue #631)', () => {
  it('compares against the readable manifests and returns the damaged key', async () => {
    const scan = {
      entries: [] as Entry[],
      deleted_items: 0,
      recrawls: [{ drive_id: 'd1', returned_item_ids: new Set<string>(['f-1']) }],
    };
    const damaged = 'onedrive/manifests/owner-1/od-snap-2-abc.json';

    const skipped = await append_recrawl_tombstones(scan, async () => ({
      manifests: [
        {
          snapshot_id: 'snap-1',
          created_at: new Date('2026-01-01'),
          entries: [stored_entry(0), stored_entry(1)],
        },
      ],
      unreadable_keys: [damaged],
    }));

    // f-0 is gone from the drive and still live in the readable history, so it is tombstoned;
    // f-1 is still listed and stays. The run goes on and names the manifest it could not read.
    expect(scan.entries.map((e) => [e.file_id, e.change_type])).toEqual([['f-0', 'deleted']]);
    expect(skipped).toEqual([damaged]);
  });
});
