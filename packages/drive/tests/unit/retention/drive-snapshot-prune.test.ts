import { describe, expect, it } from 'vitest';
import { ObjectLockRetainedError, UnreadableObjectsError } from '@wisecom/atlas-types';
import { describe_outlived_binding } from '@/shared/cursor-snapshot-binding';
import {
  BLOBS,
  OWNER,
  bucket_state,
  day,
  keys_of,
  manifest_store,
  prune,
  prune_owner,
  restored_view,
  seeded_bucket,
  snapshot_id,
  type Workload,
} from './drive-prune.fixtures';

const S = [0, 1, 2, 3, 4].map((n) => (n === 0 ? '' : snapshot_id(n)));

describe.each<Workload>(['onedrive', 'sharepoint'])('%s snapshot prune', (workload) => {
  const keys = keys_of(workload);
  const blob = (name: string): string => keys.data_key(OWNER, name);

  it('keeps what every snapshot at or after the cut-off restores, and what verify checks', async () => {
    const bucket = await seeded_bucket(workload);
    const before = [
      await restored_view(bucket.storage, workload, S[3]!),
      await restored_view(bucket.storage, workload, S[4]!),
    ];
    expect(before.join()).not.toContain('"index_row":false');

    const result = await prune(bucket.storage, workload);

    expect(await restored_view(bucket.storage, workload, S[3]!)).toBe(before[0]);
    expect(await restored_view(bucket.storage, workload, S[4]!)).toBe(before[1]);
    expect(result.baseline_snapshot_ids).toEqual([S[3]]);
    expect(result.removed_snapshot_ids.sort()).toEqual([S[1], S[2]].sort());
  });

  it('removes the older manifests with their run indexes and entry parts', async () => {
    const bucket = await seeded_bucket(workload);
    const owner = prune_owner(bucket.storage, workload);
    await prune(bucket.storage, workload);

    expect(await bucket.storage.list(keys.manifest_prefix_for(OWNER))).toEqual([
      keys.manifest_key(OWNER, S[3]!),
      keys.manifest_key(OWNER, S[4]!),
    ]);
    expect(await bucket.storage.list(`${keys.index_prefix_for(OWNER)}runs/`)).toEqual([
      keys.run_index_key(OWNER, S[3]!),
      keys.run_index_key(OWNER, S[4]!),
    ]);
    expect(await bucket.storage.list(keys.manifest_parts_prefix_for(OWNER))).toEqual([]);
    expect(owner.forgotten).toEqual([]);
  });

  it('deletes content and old versions nothing references, and keeps deduplicated blobs', async () => {
    const bucket = await seeded_bucket(workload);
    await prune(bucket.storage, workload);

    const remaining = await bucket.storage.list(keys.data_prefix_for(OWNER));
    expect(remaining).toEqual([blob('a'), blob('b2'), blob('e')]);
    // Blob a is shared through deduplication by f1 (pruned) and f4 (kept).
  });

  it('keeps a tombstone that hides an older live entry, and drops one that hides nothing', async () => {
    const bucket = await seeded_bucket(workload);
    await prune(bucket.storage, workload);

    const baseline = await manifest_store(bucket.storage, keys).read(
      keys.manifest_key(OWNER, S[3]!),
    );
    expect(baseline?.entries.map((e) => [e.file_id, e.change_type])).toEqual([
      ['f4', 'created'],
      ['f1', 'deleted'],
      ['f2', 'updated'],
      ['f3', 'deleted'],
    ]);
    expect(baseline?.total_files).toBe(4);
  });

  it('changes nothing in a dry run and reports what a run then removes', async () => {
    const bucket = await seeded_bucket(workload);
    const state = await bucket_state(bucket);

    const dry = await prune(bucket.storage, workload, { dry_run: true });
    expect(await bucket_state(bucket)).toBe(state);

    const real = await prune(bucket.storage, workload);
    expect(dry.removed_snapshot_ids.sort()).toEqual(real.removed_snapshot_ids.sort());
    expect([dry.deleted_manifests, dry.deleted_objects, dry.deleted_bytes]).toEqual([
      real.deleted_manifests,
      real.deleted_objects,
      real.deleted_bytes,
    ]);
  });

  it('reports a manifest Object Lock retains, and its content stays until a later run', async () => {
    const bucket = await seeded_bucket(workload);
    const version = bucket.versions(keys.manifest_key(OWNER, S[1]!))[0]!.version_id;
    bucket.lock(version, new ObjectLockRetainedError('k'));
    const view = await restored_view(bucket.storage, workload, S[4]!);

    const first = await prune(bucket.storage, workload);
    expect(first.retained_manifest_keys).toEqual([keys.manifest_key(OWNER, S[1]!)]);
    expect(await restored_view(bucket.storage, workload, S[4]!)).toBe(view);
    expect(await bucket.storage.exists(blob('c'))).toBe(true);
    expect(await bucket.storage.exists(keys.run_index_key(OWNER, S[1]!))).toBe(true);

    bucket.lock(version, undefined as unknown as Error);
    const second = await prune(bucket.storage, workload);
    expect(second.removed_snapshot_ids).toEqual([S[1]]);
    expect(await bucket.storage.exists(blob('c'))).toBe(false);
    expect(await bucket.storage.exists(blob('v'))).toBe(false);
  });

  it('leaves the delta cursor bound to the newest snapshot, so the next backup resumes from it', async () => {
    const bucket = await seeded_bucket(workload);
    await prune(bucket.storage, workload);

    const cursor = JSON.parse((await bucket.storage.get(keys.delta_cursor_key(OWNER))).toString());
    const manifest_keys = await bucket.storage.list(keys.manifest_prefix_for(OWNER));
    const outlived = describe_outlived_binding(cursor.snapshot_id, manifest_keys, (id) =>
      keys.manifest_key(OWNER, id),
    );
    expect(outlived).toBeUndefined();
  });

  it('refuses before writing anything while a manifest is damaged', async () => {
    const bucket = await seeded_bucket(workload);
    await manifest_store(bucket.storage, keys).damage(keys.manifest_key(OWNER, S[4]!));
    const state = await bucket_state(bucket);

    await expect(prune(bucket.storage, workload)).rejects.toBeInstanceOf(UnreadableObjectsError);
    expect(await bucket_state(bucket)).toBe(state);
  });

  it('prunes manifests but sweeps no content while a version index cannot be read', async () => {
    const bucket = await seeded_bucket(workload);
    await bucket.storage.put(
      `${keys.index_prefix_for(OWNER)}files/f9.json`,
      Buffer.from('damaged'),
    );

    const result = await prune(bucket.storage, workload);

    expect(result.removed_snapshot_ids.sort()).toEqual([S[1], S[2]].sort());
    expect(result.content_sweep_skipped).toBe('unreadable_objects');
    for (const name of BLOBS) expect(await bucket.storage.exists(blob(name))).toBe(true);
  });

  it('keeps the newest snapshot when every snapshot is older than the cut-off', async () => {
    const bucket = await seeded_bucket(workload);
    const view = await restored_view(bucket.storage, workload, S[4]!);
    const result = await prune(bucket.storage, workload, { before: day(40) });

    expect(result.baseline_snapshot_ids).toEqual([S[4]]);
    expect(await restored_view(bucket.storage, workload, S[4]!)).toBe(view);
    expect(await bucket.storage.list(keys.manifest_prefix_for(OWNER))).toEqual([
      keys.manifest_key(OWNER, S[4]!),
    ]);
  });
});
