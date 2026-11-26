import { describe, expect, it } from 'vitest';
import {
  ObjectLockRetainedError,
  OwnerBusyError,
  UnreadableObjectsError,
} from '@wisecom/atlas-types';
import {
  BLOBS,
  OWNER,
  TENANT,
  attachment_key,
  blob_key,
  bucket_state,
  day,
  manifest_key,
  outlook_store,
  pointer_key,
  prune_options,
  prune_service,
  restored_view,
  seeded_bucket,
} from './outlook-prune.fixtures';

describe('Outlook snapshot prune', () => {
  it('keeps what every snapshot at or after the cut-off restores, content included', async () => {
    const bucket = await seeded_bucket();
    const before = {
      s3: await restored_view(bucket.storage, 's3'),
      s4: await restored_view(bucket.storage, 's4'),
    };

    const { service } = prune_service(bucket.storage);
    const result = await service.prune_snapshots(TENANT, OWNER, prune_options());

    expect(await restored_view(bucket.storage, 's3')).toBe(before.s3);
    expect(await restored_view(bucket.storage, 's4')).toBe(before.s4);
    expect(result.baseline_snapshot_ids).toEqual(['s3']);
    expect(result.removed_snapshot_ids.sort()).toEqual(['s1', 's2']);
  });

  it('leaves no manifest or pointer older than the cut-off', async () => {
    const bucket = await seeded_bucket();
    const { service, repository } = prune_service(bucket.storage);
    await service.prune_snapshots(TENANT, OWNER, prune_options());

    expect(await bucket.storage.list(`manifests/${OWNER}/`)).toEqual([
      manifest_key('s3'),
      manifest_key('s4'),
    ]);
    expect(await bucket.storage.exists(pointer_key('s1'))).toBe(false);
    expect(await bucket.storage.exists(pointer_key('s2'))).toBe(false);
    expect(await bucket.storage.exists(pointer_key('s3'))).toBe(true);
    expect(repository.forgotten.sort()).toEqual(['s1', 's2']);
  });

  it('deletes only content no remaining snapshot references, and keeps deduplicated blobs', async () => {
    const bucket = await seeded_bucket();
    const { service } = prune_service(bucket.storage);
    const result = await service.prune_snapshots(TENANT, OWNER, prune_options());

    // Blob a was first stored for m1 (pruned) and is shared with m4 in s3 through deduplication.
    expect(await bucket.storage.exists(blob_key('a'))).toBe(true);
    expect(await bucket.storage.exists(blob_key('b2'))).toBe(true);
    expect(await bucket.storage.exists(blob_key('e'))).toBe(true);
    expect(await bucket.storage.exists(blob_key('b'))).toBe(false);
    expect(await bucket.storage.exists(blob_key('c'))).toBe(false);
    expect(await bucket.storage.exists(attachment_key('d'))).toBe(false);
    expect(result.content_sweep_skipped).toBeUndefined();
    expect(result.deleted_bytes).toBeGreaterThan(0);
  });

  it('folds the pruned history into the baseline under its own snapshot id', async () => {
    const bucket = await seeded_bucket();
    const { service } = prune_service(bucket.storage);
    await service.prune_snapshots(TENANT, OWNER, prune_options());

    const baseline = await outlook_store(bucket.storage).read(manifest_key('s3'));
    expect(baseline?.snapshot_id).toBe('s3');
    expect(baseline?.created_at).toEqual(day(3));
    expect(baseline?.entries.map((e) => e.object_id)).toEqual(['m4', 'm2']);
    expect(baseline?.removed_object_ids?.sort()).toEqual(['m1', 'm3']);
  });

  it('never prunes the newest snapshot, and counts a snapshot at the cut-off as newer', async () => {
    const bucket = await seeded_bucket();
    const { service } = prune_service(bucket.storage);
    const result = await service.prune_snapshots(TENANT, OWNER, prune_options({ before: day(30) }));

    expect(result.baseline_snapshot_ids).toEqual(['s4']);
    expect(await bucket.storage.list(`manifests/${OWNER}/`)).toEqual([manifest_key('s4')]);

    const at_cutoff = await seeded_bucket();
    const second = prune_service(at_cutoff.storage);
    const kept = await second.service.prune_snapshots(TENANT, OWNER, { before: day(2) });
    expect(kept.removed_snapshot_ids).toEqual(['s1']);
    expect(kept.baseline_snapshot_ids).toEqual(['s2']);
  });

  it('changes nothing in a dry run and reports what a run then removes', async () => {
    const bucket = await seeded_bucket();
    const state = await bucket_state(bucket);
    const { service } = prune_service(bucket.storage);

    const dry = await service.prune_snapshots(TENANT, OWNER, prune_options({ dry_run: true }));
    expect(await bucket_state(bucket)).toBe(state);

    const real = await service.prune_snapshots(TENANT, OWNER, prune_options());
    expect(dry.dry_run).toBe(true);
    expect(dry.removed_snapshot_ids.sort()).toEqual(real.removed_snapshot_ids.sort());
    expect(dry.deleted_manifests).toBe(real.deleted_manifests);
    expect(dry.deleted_objects).toBe(real.deleted_objects);
    expect(dry.deleted_bytes).toBe(real.deleted_bytes);
    expect(dry.deleted_objects).toBeGreaterThan(0);
  });

  it('reports a manifest Object Lock retains, keeps it shadowed, and removes it on a later run', async () => {
    const bucket = await seeded_bucket();
    const s1_version = bucket.versions(manifest_key('s1'))[0]!.version_id;
    bucket.lock(s1_version, new ObjectLockRetainedError(manifest_key('s1')));
    const s4_before = await restored_view(bucket.storage, 's4');
    const { service } = prune_service(bucket.storage);

    const first = await service.prune_snapshots(TENANT, OWNER, prune_options());
    expect(first.retained_manifest_keys).toEqual([manifest_key('s1')]);
    expect(first.failed_manifest_keys).toEqual([]);
    expect(first.removed_snapshot_ids).toEqual(['s2']);
    // s1 is still in every kept chain, and the baseline hides everything it holds.
    expect(await restored_view(bucket.storage, 's4')).toBe(s4_before);
    // The retained manifest still references these, so they stay until it goes.
    expect(await bucket.storage.exists(blob_key('b'))).toBe(true);
    expect(await bucket.storage.exists(attachment_key('d'))).toBe(true);

    bucket.lock(s1_version, undefined as unknown as Error);
    const second = await service.prune_snapshots(TENANT, OWNER, prune_options());
    expect(second.removed_snapshot_ids).toEqual(['s1']);
    expect(await bucket.storage.exists(blob_key('b'))).toBe(false);
    expect(await restored_view(bucket.storage, 's4')).toBe(s4_before);
  });

  it('is refused while another operation holds the mailbox, and changes nothing', async () => {
    const bucket = await seeded_bucket();
    const state = await bucket_state(bucket);
    const { service, leases } = prune_service(bucket.storage);
    leases.refuse_with(new OwnerBusyError({ workload: 'outlook', owner_id: OWNER }));

    await expect(service.prune_snapshots(TENANT, OWNER, prune_options())).rejects.toMatchObject({
      code: 'ATLAS_OWNER_BUSY',
    });
    expect(await bucket_state(bucket)).toBe(state);
    expect(leases.requests).toEqual([
      { workload: 'outlook', owner_id: OWNER, operation: 'delete' },
    ]);
  });

  it('refuses before writing anything while a manifest of the mailbox is damaged', async () => {
    const bucket = await seeded_bucket();
    await outlook_store(bucket.storage).damage(manifest_key('s4'));
    const state = await bucket_state(bucket);
    const { service } = prune_service(bucket.storage);

    await expect(service.prune_snapshots(TENANT, OWNER, prune_options())).rejects.toBeInstanceOf(
      UnreadableObjectsError,
    );
    expect(await bucket_state(bucket)).toBe(state);
  });

  it('prunes manifests but sweeps no content while the mailbox has a quarantined manifest', async () => {
    const bucket = await seeded_bucket();
    await bucket.storage.put(`_quarantine/manifests/${OWNER}/s0.json`, Buffer.from('damaged'));
    const { service } = prune_service(bucket.storage);

    const result = await service.prune_snapshots(TENANT, OWNER, prune_options());
    expect(result.removed_snapshot_ids.sort()).toEqual(['s1', 's2']);
    expect(result.content_sweep_skipped).toBe('quarantined_objects');
    for (const name of BLOBS) expect(await bucket.storage.exists(blob_key(name))).toBe(true);
  });

  it('leaves the delta cursor and the newest snapshot alone, so the next backup resumes', async () => {
    const bucket = await seeded_bucket();
    const { service } = prune_service(bucket.storage);
    await service.prune_snapshots(TENANT, OWNER, prune_options());

    const cursor = await bucket.storage.get(`_meta/outlook-cursors/${OWNER}.json`);
    expect(cursor.toString()).toBe('cursor of s4');
    const listing = await outlook_store(bucket.storage).list_summaries(`manifests/${OWNER}/`);
    expect(listing.summaries[0]?.snapshot_id).toBe('s4');
  });

  it('does nothing to a mailbox with no snapshot older than the cut-off', async () => {
    const bucket = await seeded_bucket();
    const state = await bucket_state(bucket);
    const { service } = prune_service(bucket.storage);

    const result = await service.prune_snapshots(TENANT, OWNER, { before: day(1) });
    expect(result.removed_snapshot_ids).toEqual([]);
    expect(result.baseline_snapshot_ids).toEqual([]);
    expect(result.deleted_objects + result.deleted_manifests).toBe(0);
    expect(await bucket_state(bucket)).toBe(state);
  });
});
